import { posix } from 'node:path';
import { Daytona, DaytonaNotFoundError, type Sandbox as SdkSandbox } from '@daytonaio/sdk';
import type { ExecOptions, ExecResult, Sandbox, SandboxProvider, SourceFile } from '@healops/shared';
import {
  DEFAULT_EXEC_TIMEOUT_SEC,
  HEALTH_PATH,
  LineSplitter,
  MIME_TYPES,
  SERVE_READY_TIMEOUT_MS,
  SERVE_SCRIPT_NAME,
  TIMEOUT_EXIT_CODE,
  assertEnvName,
  errorMessage,
  pollUntil,
  safeLabel,
  shortId,
  shq,
  sleep,
} from './common.js';

const WORKDIR_NAME = 'healops';
const MIN_NODE_MAJOR = 18;
const CREATE_TIMEOUT_SEC = 180;
const UPLOAD_TIMEOUT_SEC = 120;
const DELETE_TIMEOUT_SEC = 60;
/** Idle sandboxes stop after 15 minutes and are deleted 5 minutes after stopping. */
const AUTO_STOP_MIN = 15;
const AUTO_DELETE_MIN = 5;
/** Extra time past an exec's timeout before we stop waiting on its log stream. */
const EXEC_GRACE_SEC = 15;
/** Makes Daytona's preview proxy skip its browser warning interstitial. */
const SKIP_PREVIEW_WARNING = 'X-Daytona-Skip-Preview-Warning';

export interface DaytonaProviderConfig {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
}

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly provider = 'daytona' as const;
  private readonly client: Daytona;

  constructor(cfg: DaytonaProviderConfig) {
    this.client = new Daytona({ apiKey: cfg.apiKey, apiUrl: cfg.apiUrl, target: cfg.target });
  }

  async create(opts: { label: string; incidentId?: string }): Promise<Sandbox> {
    // The default snapshot ships Node.js (checked in create below), so no image build is needed.
    const sdk = await this.client.create(
      {
        name: `healops-${safeLabel(opts.label)}-${shortId()}`,
        labels: { app: 'healops', incident: opts.incidentId ?? 'none' },
        // public preview links, so a cloud browser can open them without credentials
        public: true,
        autoStopInterval: AUTO_STOP_MIN,
        autoDeleteInterval: AUTO_DELETE_MIN,
      },
      { timeout: CREATE_TIMEOUT_SEC },
    );
    try {
      if (!sdk.public) await sdk.setPublic(true);
      const home = (await sdk.getUserHomeDir()) ?? (await sdk.getWorkDir()) ?? '/home/daytona';
      const sandbox = new DaytonaSandbox(this.client, sdk, posix.join(home, WORKDIR_NAME));
      await sdk.fs.createFolder(sandbox.workdir, '755');
      // one API call, no session needed
      const node = await sdk.process.executeCommand('node -p "process.versions.node"', undefined, undefined, 60);
      const version = node.result.trim();
      if (node.exitCode !== 0 || !(Number(version.split('.')[0]) >= MIN_NODE_MAJOR)) {
        throw new Error(
          `Daytona sandbox ${sdk.id} has no usable Node.js >= ${MIN_NODE_MAJOR} (exit ${node.exitCode}: ${version.slice(0, 200)})`,
        );
      }
      return sandbox;
    } catch (err) {
      await this.client.delete(sdk, DELETE_TIMEOUT_SEC, false).catch(() => undefined);
      throw err;
    }
  }
}

class DaytonaSandbox implements Sandbox {
  readonly provider = 'daytona' as const;
  readonly id: string;
  /** port -> id of the session running that port's static server */
  private readonly servers = new Map<number, string>();

  constructor(
    private readonly client: Daytona,
    private readonly sdk: SdkSandbox,
    readonly workdir: string,
  ) {
    this.id = sdk.id;
  }

  async writeFiles(files: SourceFile[], subdir = ''): Promise<void> {
    if (files.length === 0) return;
    // the upload API creates missing parent folders
    await this.sdk.fs.uploadFiles(
      files.map((file) => ({
        source: Buffer.from(file.content, 'utf8'),
        destination: this.resolve(posix.join(subdir, file.path)),
      })),
      UPLOAD_TIMEOUT_SEC,
    );
  }

  async readFile(rel: string): Promise<string> {
    return (await this.sdk.fs.downloadFile(this.resolve(rel))).toString('utf8');
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const timeoutSec = opts.timeoutSec && opts.timeoutSec > 0 ? opts.timeoutSec : DEFAULT_EXEC_TIMEOUT_SEC;
    const command = wrapCommand(cmd, this.resolve(opts.cwd ?? '.'), timeoutSec, opts.env);
    const sid = `exec-${shortId(4)}`;
    const splitter = new LineSplitter(opts.onLine);
    let output = '';
    let closed = false;
    const onChunk = (chunk: string) => {
      if (closed) return;
      output += chunk;
      splitter.push(chunk);
    };

    await this.sdk.process.createSession(sid);
    try {
      const { cmdId } = await this.sdk.process.executeSessionCommand(sid, { command, runAsync: true });
      if (!cmdId) throw new Error('Daytona returned no command id for exec');

      const stream = this.sdk.process.getSessionCommandLogs(sid, cmdId, onChunk, onChunk).then(
        (): 'done' => 'done',
        (err: unknown): { error: string } => ({ error: errorMessage(err) }),
      );
      let deadline: NodeJS.Timeout | undefined;
      const stalled = new Promise<'stalled'>((resolve) => {
        deadline = setTimeout(() => resolve('stalled'), (timeoutSec + EXEC_GRACE_SEC) * 1000);
      });
      const outcome = await Promise.race([stream, stalled]);
      clearTimeout(deadline);
      closed = true;
      splitter.flush();

      if (outcome === 'stalled') {
        output += `\n[healops] no completion after ${timeoutSec + EXEC_GRACE_SEC}s; stopped waiting`;
        return { exitCode: TIMEOUT_EXIT_CODE, output, durationMs: Date.now() - started };
      }
      if (typeof outcome === 'object') output += `\n[healops] log stream error: ${outcome.error}`;
      const exitCode = (await this.exitCodeOf(sid, cmdId)) ?? -1;
      return { exitCode, output, durationMs: Date.now() - started };
    } finally {
      closed = true;
      await this.sdk.process.deleteSession(sid).catch(() => undefined);
    }
  }

  async serveStatic(subdir: string, port: number): Promise<{ url: string; public: boolean }> {
    const root = this.resolve(subdir);
    await this.stopServer(port);
    await this.sdk.fs.uploadFiles(
      [{ source: Buffer.from(SERVE_SCRIPT, 'utf8'), destination: this.resolve(SERVE_SCRIPT_NAME) }],
      UPLOAD_TIMEOUT_SEC,
    );

    const nonce = shortId(4);
    const health = `healops-serve ${nonce}`;
    const sid = `serve-${port}-${nonce}`;
    await this.sdk.process.createSession(sid);
    this.servers.set(port, sid);
    let cmdId: string | undefined;
    try {
      const started = await this.sdk.process.executeSessionCommand(sid, {
        command: `cd ${shq(this.workdir)} && node ${SERVE_SCRIPT_NAME} ${shq(root)} ${port} ${nonce}`,
        runAsync: true,
      });
      cmdId = started.cmdId;

      // 1) the server answers inside the sandbox (fast; also surfaces startup errors)
      const probe = `node -e "fetch('http://127.0.0.1:${port}${HEALTH_PATH}').then((r) => r.text()).then((t) => process.exit(t === '${health}' ? 0 : 1), () => process.exit(1))"`;
      const inside = await this.sdk.process
        .executeCommand(`sh -c ${shq(`until ${probe}; do sleep 0.25; done`)}`, undefined, undefined, 20)
        .then(
          (r) => (r.exitCode === 0 ? 'ok' : `exit ${r.exitCode}`),
          (err: unknown) => `probe timed out or failed: ${errorMessage(err)}`,
        );
      if (inside !== 'ok') {
        throw await this.serveError(sid, cmdId, port, `no answer inside the sandbox (${inside})`);
      }

      // 2) the public preview URL answers with our health body (not the warning page)
      const preview = await this.sdk.getPreviewLink(port);
      const url = preview.url.replace(/\/+$/, '');
      const headers: Record<string, string> = { [SKIP_PREVIEW_WARNING]: 'true' };
      if (!this.sdk.public) headers['X-Daytona-Preview-Token'] = preview.token;
      const ready = await pollUntil(
        async () => {
          const res = await fetch(`${url}${HEALTH_PATH}`, { headers, signal: AbortSignal.timeout(5_000) });
          return res.ok && (await res.text()) === health;
        },
        SERVE_READY_TIMEOUT_MS,
      );
      if (!ready) {
        throw await this.serveError(sid, cmdId, port, `preview URL did not answer within ${SERVE_READY_TIMEOUT_MS / 1000}s`);
      }
      return { url, public: this.sdk.public };
    } catch (err) {
      await this.stopServer(port);
      throw err;
    }
  }

  async destroy(): Promise<void> {
    this.servers.clear();
    try {
      await this.client.delete(this.sdk, DELETE_TIMEOUT_SEC, true);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }

  /** Absolute sandbox path for a workdir-relative path; rejects anything that escapes the workdir. */
  private resolve(rel: string): string {
    const target = posix.normalize(posix.join(this.workdir, rel.replace(/\\/g, '/')));
    if (target !== this.workdir && !target.startsWith(`${this.workdir}/`)) {
      throw new Error(`path escapes the sandbox workdir: ${rel}`);
    }
    return target;
  }

  private async exitCodeOf(sid: string, cmdId: string): Promise<number | undefined> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const cmd = await this.sdk.process.getSessionCommand(sid, cmdId);
      if (typeof cmd.exitCode === 'number') return cmd.exitCode;
      await sleep(300);
    }
    return undefined;
  }

  private async stopServer(port: number): Promise<void> {
    const sid = this.servers.get(port);
    if (!sid) return;
    this.servers.delete(port);
    await this.sdk.process.deleteSession(sid).catch(() => undefined);
    await sleep(500); // give the port a moment to be released
  }

  private async serveError(sid: string, cmdId: string | undefined, port: number, reason: string): Promise<Error> {
    let log = '';
    if (cmdId) {
      const logs = await this.sdk.process.getSessionCommandLogs(sid, cmdId).catch(() => undefined);
      log = `${logs?.stdout ?? ''}${logs?.stderr ?? ''}`.trim().slice(-600);
    }
    return new Error(`serveStatic(${port}) failed: ${reason}${log ? `; server log: ${log}` : ''}`);
  }
}

/**
 * Runs `cmd` through sh in `cwd` with a hard timeout (GNU timeout kills the whole process group)
 * and optional env vars. Sessions have no cwd or env parameters, so both are folded into the command.
 * stderr is merged into stdout: the daemon streams them separately, which would reorder lines.
 */
function wrapCommand(cmd: string, cwd: string, timeoutSec: number, env?: Record<string, string>): string {
  const assignments = Object.entries(env ?? {}).map(([name, value]) => {
    assertEnvName(name);
    return `${name}=${shq(value)}`;
  });
  const envPrefix = assignments.length > 0 ? `env ${assignments.join(' ')} ` : '';
  return `cd ${shq(cwd)} && timeout -k 5 ${Math.ceil(timeoutSec)} ${envPrefix}sh -c ${shq(cmd)} 2>&1`;
}

function isMissing(err: unknown): boolean {
  if (err instanceof DaytonaNotFoundError) return true;
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return status === 404 || status === 410;
}

/** Static file server written into the sandbox. Serves Cache-Control: no-store and a nonce-stamped health route. */
const SERVE_SCRIPT = [
  '// Written by @healops/daytona: serves one directory over HTTP with Cache-Control: no-store.',
  "import fs from 'node:fs';",
  "import http from 'node:http';",
  "import path from 'node:path';",
  "const [root, portArg, nonce = ''] = process.argv.slice(2);",
  'const base = path.resolve(root);',
  'const port = Number(portArg);',
  `const TYPES = ${JSON.stringify(MIME_TYPES)};`,
  'function send(res, status, body) {',
  "  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });",
  '  res.end(body);',
  '}',
  'function statOrNull(p) {',
  '  try { return fs.statSync(p); } catch { return null; }',
  '}',
  'const server = http.createServer((req, res) => {',
  '  try {',
  "    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');",
  "    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);",
  `    if (pathname === '${HEALTH_PATH}') return send(res, 200, 'healops-serve ' + nonce);`,
  '    let file = path.join(base, pathname);',
  "    if (file !== base && !file.startsWith(base + path.sep)) return send(res, 403, 'forbidden');",
  '    let stat = statOrNull(file);',
  "    if (stat && stat.isDirectory()) { file = path.join(file, 'index.html'); stat = statOrNull(file); }",
  "    if (!stat || !stat.isFile()) return send(res, 404, 'not found');",
  "    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-store' });",
  "    if (req.method === 'HEAD') return res.end();",
  "    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);",
  '  } catch {',
  "    if (!res.headersSent) send(res, 400, 'bad request');",
  '  }',
  '});',
  "server.on('error', (err) => { console.error('healops-serve: ' + (err.code || err.message) + ' on port ' + port); process.exit(1); });",
  "server.listen(port, '0.0.0.0', () => console.log('healops-serve: serving ' + base + ' on port ' + port));",
  '',
].join('\n');
