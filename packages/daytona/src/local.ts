import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ExecOptions, ExecResult, Sandbox, SandboxProvider, SourceFile } from '@healops/shared';
import {
  DEFAULT_EXEC_TIMEOUT_SEC,
  LineSplitter,
  MIME_TYPES,
  TIMEOUT_EXIT_CODE,
  safeLabel,
  shortId,
} from './common.js';

/** Fallback provider: each sandbox is a folder under <dataDir>/sandboxes; commands run in the platform shell. */
export class LocalSandboxProvider implements SandboxProvider {
  readonly provider = 'local' as const;

  constructor(private readonly dataDir: string) {}

  async create(opts: { label: string; incidentId?: string }): Promise<Sandbox> {
    const id = `${safeLabel(opts.label)}-${shortId()}`;
    const workdir = path.join(this.dataDir, 'sandboxes', id);
    await fs.promises.mkdir(workdir, { recursive: true });
    return new LocalSandbox(id, workdir);
  }
}

class LocalSandbox implements Sandbox {
  readonly provider = 'local' as const;
  private readonly servers = new Set<http.Server>();
  private readonly running = new Set<ChildProcess>();

  constructor(
    readonly id: string,
    readonly workdir: string,
  ) {}

  async writeFiles(files: SourceFile[], subdir = ''): Promise<void> {
    for (const file of files) {
      const target = this.resolve(path.join(subdir, file.path));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, file.content, 'utf8');
    }
  }

  readFile(rel: string): Promise<string> {
    return fs.promises.readFile(this.resolve(rel), 'utf8');
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const cwd = this.resolve(opts.cwd ?? '.');
    const timeoutSec = opts.timeoutSec && opts.timeoutSec > 0 ? opts.timeoutSec : DEFAULT_EXEC_TIMEOUT_SEC;
    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    const started = Date.now();

    return new Promise<ExecResult>((resolve) => {
      const child = spawn(cmd, {
        cwd,
        env,
        shell: true,
        windowsHide: true,
        // own process group on POSIX, so a timeout can kill the whole tree
        detached: process.platform !== 'win32',
      });
      this.running.add(child);

      const splitter = new LineSplitter(opts.onLine);
      const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
      let output = '';
      let settled = false;
      let timedOut = false;
      let exitCode: number | undefined;
      let grace: NodeJS.Timeout | undefined;

      const emit = (text: string) => {
        output += text;
        splitter.push(text);
      };
      const pump = (index: number) => (chunk: Buffer) => emit(decoders[index].write(chunk));
      child.stdout?.on('data', pump(0));
      child.stderr?.on('data', pump(1));

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutSec * 1000);

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        this.running.delete(child);
        emit(decoders.map((d) => d.end()).join(''));
        if (timedOut) emit(`\n[healops] timed out after ${timeoutSec}s`);
        splitter.flush();
        resolve({
          exitCode: timedOut ? TIMEOUT_EXIT_CODE : (exitCode ?? 1),
          output,
          durationMs: Date.now() - started,
        });
      };

      child.on('error', (err) => {
        exitCode = 127;
        emit(`\n[healops] ${err.message}`);
        finish();
      });
      child.on('exit', (code, signal) => {
        exitCode = code ?? (signal ? 128 : 1);
        // background children may keep stdio open after the shell exits; don't wait for them forever
        grace = setTimeout(finish, 300);
      });
      child.on('close', (code) => {
        exitCode ??= code ?? 1;
        finish();
      });
    });
  }

  async serveStatic(subdir: string, port: number): Promise<{ url: string; public: boolean }> {
    const root = this.resolve(subdir);
    for (let candidate = port; candidate < port + 50; candidate++) {
      try {
        this.servers.add(await listen(root, candidate));
        return { url: `http://localhost:${candidate}`, public: false };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err;
      }
    }
    throw new Error(`serveStatic: no free port between ${port} and ${port + 49}`);
  }

  async destroy(): Promise<void> {
    for (const child of this.running) killTree(child);
    this.running.clear();
    await Promise.all([...this.servers].map(closeServer));
    this.servers.clear();
    await fs.promises.rm(this.workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  /** Absolute path for a workdir-relative path; rejects anything that escapes the workdir. */
  private resolve(rel: string): string {
    const target = path.join(this.workdir, rel);
    if (target !== this.workdir && !target.startsWith(this.workdir + path.sep)) {
      throw new Error(`path escapes the sandbox workdir: ${rel}`);
    }
    return target;
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () =>
      child.kill(),
    );
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function listen(root: string, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => handleStatic(root, req, res));
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.on('error', () => undefined);
      resolve(server);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function handleStatic(root: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    let file = path.join(root, pathname);
    if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, 'forbidden');
    let stat = statOrNull(file);
    if (stat?.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = statOrNull(file);
    }
    if (!stat?.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  } catch {
    if (!res.headersSent) send(res, 400, 'bad request');
  }
}

function send(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
