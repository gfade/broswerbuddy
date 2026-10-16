import { randomBytes } from 'node:crypto';

/** Wall-clock limit for one exec when the caller gives none. */
export const DEFAULT_EXEC_TIMEOUT_SEC = 120;
/** Exit code for a command killed by its timeout (same as coreutils `timeout`). */
export const TIMEOUT_EXIT_CODE = 124;
/** How long serveStatic waits for the static server to answer. */
export const SERVE_READY_TIMEOUT_MS = 20_000;
/** Health route of the static server; readiness checks read it and expect a per-start nonce. */
export const HEALTH_PATH = '/__healops/health';
/** Node script that serves a directory; the Daytona provider uploads it into the sandbox workdir. */
export const SERVE_SCRIPT_NAME = '.healops-serve.mjs';

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function shortId(bytes = 3): string {
  return randomBytes(bytes).toString('hex');
}

/** Lower-case, filesystem- and label-safe fragment of a free-text label. */
export function safeLabel(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'sandbox';
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Calls `check` until it resolves true or `timeoutMs` elapses. Errors count as "not yet". */
export async function pollUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return true;
    } catch {
      /* not ready yet */
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/** POSIX single-quote a value for sh/zsh/dash. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertEnvName(name: string): void {
  if (!ENV_NAME.test(name)) throw new Error(`invalid environment variable name: ${JSON.stringify(name)}`);
}

/** Splits streamed text into lines. Complete lines are emitted as they arrive; the rest on flush(). */
export class LineSplitter {
  private pending = '';

  constructor(private readonly onLine?: (line: string) => void) {}

  push(text: string): void {
    if (!this.onLine || text === '') return;
    this.pending += text;
    let nl = this.pending.indexOf('\n');
    while (nl !== -1) {
      this.emit(this.pending.slice(0, nl));
      this.pending = this.pending.slice(nl + 1);
      nl = this.pending.indexOf('\n');
    }
  }

  flush(): void {
    if (this.pending !== '') this.emit(this.pending);
    this.pending = '';
  }

  private emit(line: string): void {
    try {
      this.onLine?.(line.endsWith('\r') ? line.slice(0, -1) : line);
    } catch {
      /* a faulty consumer must not break exec */
    }
  }
}
