import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FlagInput, HealOpsRuntime, ServerMessage } from '@healops/shared';

export interface ServerOptions {
  port: number;
  dashboardDir?: string;
  widgetFile?: string;
  artifactsDir: string;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

const MAX_BODY = 256 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Error with an HTTP status; anything else becomes a 500. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const badRequest = (message: string) => new HttpError(400, message);

/** Decode one path segment; a malformed escape is a client error, not a 500. */
function seg(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? '');
  } catch {
    throw badRequest('malformed path segment');
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function applyCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

/** Read and parse a JSON body; empty body yields {}. Enforces the 256KB limit. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY) {
      reject(new HttpError(413, `request body exceeds ${MAX_BODY} bytes`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        reject(new HttpError(413, `request body exceeds ${MAX_BODY} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (tooLarge) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(badRequest('body is not valid JSON'));
      }
    });
  });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate a bug-report body against FlagInput. Returns a clean copy. */
export function parseFlag(body: unknown): FlagInput {
  if (!isObject(body)) throw badRequest('body must be a JSON object');
  const { note, url, events, consoleErrors, viewport, userAgent } = body;
  if (typeof note !== 'string' || note.trim().length < 1 || note.length > 2000) {
    throw badRequest('note must be a string of 1..2000 characters');
  }
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) {
    throw badRequest('url must be a non-empty string');
  }
  const flag: FlagInput = { note, url };
  if (events !== undefined) {
    if (!Array.isArray(events) || events.length > 50) throw badRequest('events must be an array of at most 50 items');
    flag.events = events.map((e, i) => {
      if (!isObject(e) || typeof e.type !== 'string' || typeof e.at !== 'number') {
        throw badRequest(`events[${i}] needs a string type and a numeric at`);
      }
      return {
        type: e.type,
        at: e.at,
        target: typeof e.target === 'string' ? e.target : undefined,
        detail: typeof e.detail === 'string' ? e.detail : undefined,
      };
    });
  }
  if (consoleErrors !== undefined) {
    if (!Array.isArray(consoleErrors) || consoleErrors.length > 20 || !consoleErrors.every((s) => typeof s === 'string')) {
      throw badRequest('consoleErrors must be an array of at most 20 strings');
    }
    flag.consoleErrors = consoleErrors as string[];
  }
  if (viewport !== undefined) {
    if (!Array.isArray(viewport) || viewport.length !== 2 || !viewport.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw badRequest('viewport must be [width, height]');
    }
    flag.viewport = [viewport[0] as number, viewport[1] as number];
  }
  if (userAgent !== undefined) {
    if (typeof userAgent !== 'string') throw badRequest('userAgent must be a string');
    flag.userAgent = userAgent.slice(0, 500);
  }
  return flag;
}

/** Resolve a request path inside `root`; returns undefined for anything escaping it. */
function safeJoin(root: string, rel: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const base = path.resolve(root);
  const full = path.resolve(base, '.' + path.posix.sep + decoded.replace(/^\/+/, ''));
  if (full !== base && !full.startsWith(base + path.sep)) return undefined;
  return full;
}

function sendFile(res: http.ServerResponse, file: string, headers: Record<string, string>): void {
  const type = STATIC_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, ...headers });
  fs.createReadStream(file).pipe(res);
}

function fileExists(file: string | undefined): file is string {
  if (!file) return false;
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

const NO_DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HealOps API</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#1d1d1f}
code{background:#f2f2f4;padding:2px 6px;border-radius:4px}</style></head>
<body><h1>HealOps API is running</h1>
<p>The dashboard build is missing. Either run <code>npm run build</code> and reload this page,
or open the Vite dev server at <a href="http://localhost:5173">http://localhost:5173</a>.</p>
<p>REST lives under <code>/api</code>, live events at <code>/ws</code>.</p></body></html>`;

export async function startServer(runtime: HealOpsRuntime, opts: ServerOptions): Promise<RunningServer> {
  const artifactsDir = path.resolve(opts.artifactsDir);
  const sockets = new Set<import('node:net').Socket>();

  const json = async (res: http.ServerResponse, fn: () => Promise<[number, unknown]> | [number, unknown]) => {
    try {
      const [status, body] = await fn();
      sendJson(res, status, body);
    } catch (err) {
      if (err instanceof HttpError) sendError(res, err.status, err.message);
      else sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  };

  /** Runtime refusals (wrong state, unknown target) surface as 409 with the runtime's message. */
  const refuse = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err));
    }
  };
  const requireIncident = async (id: string): Promise<void> => {
    if (!(await runtime.getIncident(id))) throw new HttpError(404, `incident ${id} not found`);
  };

  const handleApi = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> => {
    const method = req.method ?? 'GET';
    const segs = pathname.split('/').filter(Boolean); // ['api', ...]
    const route = segs.slice(1);
    const notFound = () => new HttpError(404, `no route ${method} ${pathname}`);
    const needGet = () => { if (method !== 'GET') throw new HttpError(405, `${pathname} only accepts GET`); };
    const needPost = () => { if (method !== 'POST') throw new HttpError(405, `${pathname} only accepts POST`); };

    await json(res, async () => {
      const head = route[0];
      if (head === 'health') {
        needGet();
        return [200, { ok: true, modes: runtime.modes, liveUrl: runtime.liveUrl() }];
      }
      if (head === 'flows' && route.length === 1) {
        needGet();
        return [200, runtime.listFlows()];
      }
      if (head === 'flows' && route.length === 3 && route[2] === 'run') {
        needPost();
        const flowId = seg(route[1]);
        if (!runtime.listFlows().some((f) => f.id === flowId)) throw new HttpError(404, `flow ${flowId} not found`);
        const { result, incidentId } = await runtime.runFlow(flowId, 'manual');
        return [200, { result, incidentId }];
      }
      if (head === 'flags' && route.length === 1) {
        needPost();
        const flag = parseFlag(await readJsonBody(req));
        return [200, await runtime.submitFlag(flag)];
      }
      if (head === 'incidents' && route.length === 1) {
        needGet();
        return [200, await runtime.listIncidents()];
      }
      if (head === 'incidents' && route.length === 2) {
        needGet();
        const incident = await runtime.getIncident(seg(route[1]));
        if (!incident) throw new HttpError(404, `incident ${seg(route[1])} not found`);
        return [200, incident];
      }
      if (head === 'incidents' && route.length === 3 && route[2] === 'approve') {
        needPost();
        const body = await readJsonBody(req);
        if (!isObject(body) || typeof body.approved !== 'boolean') throw badRequest('body must be { approved: boolean }');
        const incidentId = seg(route[1]);
        await requireIncident(incidentId);
        const approved: boolean = body.approved;
        await refuse(() => runtime.approve(incidentId, approved));
        return [200, { ok: true }];
      }
      if (head === 'incidents' && route.length === 3 && route[2] === 'takeover') {
        needPost();
        const incidentId = seg(route[1]);
        await requireIncident(incidentId);
        await refuse(() => runtime.takeover(incidentId));
        return [200, { ok: true }];
      }
      if (head === 'deploy' && route[1] === 'rollback' && route.length === 2) {
        needPost();
        let restored: { restoredVersion: string } | undefined;
        await refuse(async () => { restored = await runtime.rollback(); });
        return [200, restored];
      }
      if (head === 'seeds' && route.length === 1) {
        needGet();
        return [200, runtime.seeds()];
      }
      if (head === 'seeds' && route.length === 3 && route[2] === 'reseed') {
        needPost();
        const seedId = seg(route[1]);
        if (!runtime.seeds().some((s) => s.id === seedId)) throw new HttpError(404, `seed ${seedId} not found`);
        let reseeded: { version: string } | undefined;
        await refuse(async () => { reseeded = await runtime.reseed(seedId); });
        return [200, reseeded];
      }
      if (head === 'memory' && route[1] === 'graph' && route.length === 2) {
        needGet();
        return [200, await runtime.memoryGraph()];
      }
      if (head === 'stats' && route.length === 1) {
        needGet();
        return [200, await runtime.stats()];
      }
      if (head === 'patrol' && route.length === 2 && route[1] === 'start') {
        needPost();
        const body = await readJsonBody(req);
        const raw = isObject(body) ? body.intervalSec : undefined;
        if (raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 5)) {
          throw badRequest('intervalSec must be a number >= 5');
        }
        runtime.startPatrol(raw as number | undefined);
        return [200, { ok: true, patrolling: true }];
      }
      if (head === 'patrol' && route.length === 2 && route[1] === 'stop') {
        needPost();
        runtime.stopPatrol();
        return [200, { ok: true, patrolling: false }];
      }
      throw notFound();
    });
  };

  const serveArtifact = (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'artifacts only accept GET');
    const name = pathname.slice('/artifacts/'.length);
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      return sendError(res, 400, 'invalid artifact name');
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      return sendError(res, 400, 'invalid artifact name');
    }
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('..') || decoded.includes('\0')) {
      return sendError(res, 400, 'invalid artifact name');
    }
    const type = IMAGE_TYPES[path.extname(decoded).toLowerCase()];
    if (!type) return sendError(res, 415, 'only png, jpg and webp artifacts are served');
    const file = path.join(artifactsDir, decoded);
    if (path.dirname(file) !== artifactsDir || !fileExists(file)) return sendError(res, 404, 'artifact not found');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(file).pipe(res);
  };

  const serveWidget = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'widget only accepts GET');
    if (!fileExists(opts.widgetFile)) {
      return sendError(res, 404, 'widget bundle not built: run npm run build -w @healops/widget');
    }
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(opts.widgetFile).pipe(res);
  };

  const serveDashboard = (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method not allowed');
    const dir = opts.dashboardDir ? path.resolve(opts.dashboardDir) : undefined;
    const indexFile = dir ? path.join(dir, 'index.html') : undefined;
    if (!fileExists(indexFile)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return void res.end(NO_DASHBOARD_HTML);
    }
    const requested = dir ? safeJoin(dir, pathname) : undefined;
    if (!requested) return sendError(res, 400, 'invalid path');
    // Real file (hashed assets, favicon, ...) -> serve it. Anything else -> SPA shell.
    const hasExtension = path.extname(pathname) !== '';
    if (fileExists(requested)) {
      const isHashed = pathname.startsWith('/assets/');
      return void sendFile(res, requested, { 'Cache-Control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache' });
    }
    if (hasExtension) return sendError(res, 404, 'not found');
    return void sendFile(res, indexFile!, { 'Cache-Control': 'no-cache' });
  };

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    applyCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return void res.end();
    }
    try {
      if (pathname === '/api' || pathname.startsWith('/api/')) return void handleApi(req, res, pathname);
      if (pathname.startsWith('/artifacts/')) return serveArtifact(req, res, pathname);
      if (pathname === '/widget/healops.js') return serveWidget(req, res);
      return serveDashboard(req, res, pathname);
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // WebSocket: upgrade only on /ws.
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const clients = new Set<WebSocket>();
  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    const hello: ServerMessage = {
      kind: 'hello',
      modes: runtime.modes,
      liveUrl: runtime.liveUrl(),
      serverTime: Date.now(),
      recent: runtime.bus.recent(300),
    };
    ws.send(JSON.stringify(hello));
    const unsubscribe = runtime.bus.subscribe((event) => {
      if (ws.readyState !== ws.OPEN) return;
      const msg: ServerMessage = { kind: 'event', event };
      ws.send(JSON.stringify(msg));
    });
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 25_000);
    const cleanup = () => {
      clearInterval(ping);
      unsubscribe();
      clients.delete(ws);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const address = httpServer.address() as AddressInfo;
  const url = `http://localhost:${address.port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of clients) ws.terminate();
        wss.close();
        httpServer.close(() => resolve());
        httpServer.closeIdleConnections();
        for (const socket of sockets) socket.destroy();
      }),
  };
}
