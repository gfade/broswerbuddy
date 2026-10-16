import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { createLogger, type HealOpsConfig, type SourceFile } from '@healops/shared';
import { emptyState, parseState, StoreDeployer, type DeployState } from './base.js';
import { contentTypeFor, decodeSegment, escapeHtml, isHtml, isValidVersion, rewriteHtml } from './common.js';

const log = createLogger('deploy');
const TEXT = 'text/plain; charset=utf-8';
const HTML = 'text/html; charset=utf-8';

/**
 * Local host. Releases are kept under <dataDir>/deploy/releases/<version>. An HTTP server on
 * cfg.storePort serves the live release at "/" and any staged release at "/__canary/<version>/".
 */
export class LocalDeployer extends StoreDeployer {
  readonly provider = 'local' as const;
  private readonly stateDir: string;
  private readonly releasesDir: string;
  private readonly statePath: string;
  private readonly port: number;
  private readonly publicUrl: string | undefined;
  private server: Server | undefined;
  private starting: Promise<void> | undefined;

  constructor(private readonly cfg: HealOpsConfig) {
    super();
    this.stateDir = path.join(cfg.dataDir, 'deploy');
    this.releasesDir = path.join(this.stateDir, 'releases');
    this.statePath = path.join(this.stateDir, 'state.json');
    this.port = cfg.storePort ?? 4000;
    this.publicUrl = cfg.publicStoreUrl?.replace(/\/+$/, '') || undefined;
  }

  liveUrl(): string {
    return this.publicUrl ?? `http://localhost:${this.port}`;
  }

  protected canaryUrl(version: string): string {
    return `${this.liveUrl()}/__canary/${version}`;
  }

  protected async readState(): Promise<DeployState> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, 'utf8');
    } catch (err) {
      if (isCode(err, 'ENOENT')) return emptyState();
      throw err;
    }
    return parseState(raw, this.statePath);
  }

  protected async writeState(state: DeployState): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, this.statePath);
  }

  protected async writeRelease(version: string, files: SourceFile[]): Promise<void> {
    const dir = path.join(this.releasesDir, version);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (const file of files) {
      const target = path.join(dir, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
    }
  }

  protected async releaseExists(version: string): Promise<boolean> {
    return (await statOrNull(path.join(this.releasesDir, version)))?.isDirectory() ?? false;
  }

  protected async readRelease(version: string): Promise<SourceFile[]> {
    const dir = path.join(this.releasesDir, version);
    if (!(await this.releaseExists(version))) throw new Error(`release ${version} is missing from ${dir}`);
    return readTree(dir, '');
  }

  /** Nothing to copy: serving follows the live pointer in state. */
  protected async activate(): Promise<void> {}

  protected override async prepare(): Promise<void> {
    await this.ensureServer();
  }

  protected async shutdown(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    this.starting = undefined;
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private ensureServer(): Promise<void> {
    this.starting ??= this.startServer().catch((err: unknown) => {
      this.starting = undefined;
      throw err;
    });
    return this.starting;
  }

  private startServer(): Promise<void> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        log.error(`request ${req.url ?? ''} failed:`, err);
        if (res.headersSent) res.end();
        else send(res, 500, TEXT, 'internal error', false);
      });
    });
    return new Promise<void>((resolve, reject) => {
      const onStartError = (err: Error) => {
        const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
        reject(busy ? new Error(`store port ${this.port} is already in use (set HEALOPS_STORE_PORT)`) : err);
      };
      server.once('error', onStartError);
      server.listen(this.port, () => {
        server.off('error', onStartError);
        server.on('error', (err) => log.error('store server error:', err));
        this.server = server;
        log.info(`store listening on http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, TEXT, 'method not allowed', false, { Allow: 'GET, HEAD' });
      return;
    }
    const headOnly = method === 'HEAD';

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://store.local');
    } catch {
      send(res, 400, TEXT, 'bad request', headOnly);
      return;
    }

    if (url.pathname === '/__version') {
      const { live } = await this.readState();
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ version: live ?? '' }), headOnly);
      return;
    }

    let version: string;
    let relSegments: string[];
    const segments = url.pathname.split('/').filter((s) => s !== '');
    if (segments[0] === '__canary') {
      const requested = segments[1] === undefined ? undefined : decodeSegment(segments[1]);
      if (requested === undefined || !isValidVersion(requested) || !(await this.releaseExists(requested))) {
        notFound(res, url.pathname, headOnly);
        return;
      }
      version = requested;
      relSegments = segments.slice(2);
    } else {
      const { live } = await this.readState();
      if (!live) {
        send(res, 503, TEXT, 'no live version yet', headOnly);
        return;
      }
      version = live;
      relSegments = segments;
    }

    const base = path.join(this.releasesDir, version);
    const parts: string[] = [];
    for (const segment of relSegments) {
      const decoded = decodeSegment(segment);
      if (decoded === undefined) {
        notFound(res, url.pathname, headOnly);
        return;
      }
      parts.push(decoded);
    }
    let target = path.join(base, ...parts);
    if (!isInside(base, target)) {
      notFound(res, url.pathname, headOnly);
      return;
    }

    let info = await statOrNull(target);
    if (info?.isDirectory()) {
      // Redirect so that relative asset URLs in the page resolve under the directory.
      if (!url.pathname.endsWith('/')) {
        res.writeHead(302, { Location: `${url.pathname}/${url.search}`, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      target = path.join(target, 'index.html');
      info = await statOrNull(target);
    }
    if (!info?.isFile()) {
      notFound(res, url.pathname, headOnly);
      return;
    }

    const raw = await readFile(target);
    const body = isHtml(target) ? rewriteHtml(raw.toString('utf8'), version, this.cfg.publicApiUrl) : raw;
    send(res, 200, contentTypeFor(target), body, headOnly);
  }
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  headOnly: boolean,
  extra: Record<string, string> = {},
): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  if (headOnly) res.end();
  else res.end(buf);
}

function notFound(res: ServerResponse, pathname: string, headOnly: boolean): void {
  const page = `<!doctype html>
<meta charset="utf-8">
<title>404 Not Found</title>
<h1>404 Not Found</h1>
<p>${escapeHtml(pathname)} is not in this store.</p>
`;
  send(res, 404, HTML, page, headOnly);
}

/** True when `target` is `base` itself or lies beneath it. */
function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function statOrNull(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

function isCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

/** Every file under `root/rel`, as forward-slash paths with utf8 content, sorted by name. */
async function readTree(root: string, rel: string): Promise<SourceFile[]> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: SourceFile[] = [];
  for (const entry of entries) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await readTree(root, child)));
    } else if (entry.isFile()) {
      files.push({ path: child, content: await readFile(path.join(root, child), 'utf8') });
    }
  }
  return files;
}
