import { createTwoFilesPatch } from 'diff';
import type { CodeEdit, SourceFile } from './types.js';

/** Time-sortable id with a prefix, e.g. "inc_m3k2z9_a1b2". */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function truncate(text: string, max = 4000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

/** True for localhost / 127.x / ::1 URLs (not reachable from cloud browsers). */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.') || host === '0.0.0.0';
  } catch {
    return false;
  }
}

const COLORS: Record<string, string> = {
  anchor: '\x1b[38;5;75m',
  daytona: '\x1b[38;5;155m',
  bedrock: '\x1b[38;5;214m',
  aws: '\x1b[38;5;214m',
  surreal: '\x1b[38;5;199m',
  arize: '\x1b[38;5;141m',
  agent: '\x1b[38;5;99m',
  server: '\x1b[38;5;250m',
};

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/** Namespaced, coloured console logger. Set HEALOPS_DEBUG=1 for debug output. */
export function createLogger(ns: string): Logger {
  const color = COLORS[ns] ?? '\x1b[38;5;245m';
  const tag = `${color}[${ns}]\x1b[0m`;
  return {
    info: (...a) => console.log(tag, ...a),
    warn: (...a) => console.warn(tag, '\x1b[33mwarn\x1b[0m', ...a),
    error: (...a) => console.error(tag, '\x1b[31merror\x1b[0m', ...a),
    debug: (...a) => {
      if (process.env.HEALOPS_DEBUG) console.log(tag, '\x1b[2m', ...a, '\x1b[0m');
    },
  };
}

/** Unified diff for one file. */
export function unifiedDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 });
}

export interface ApplyEditsResult {
  files: SourceFile[];
  /** unified diff of all changed files */
  diff: string;
  changed: string[];
  errors: string[];
}

/** Apply exact find/replace edits. Each `find` must match exactly once (CRLF-insensitive). */
export function applyEdits(files: SourceFile[], edits: CodeEdit[]): ApplyEditsResult {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const original = new Map(byPath);
  const errors: string[] = [];

  for (const edit of edits) {
    const path = edit.path.replace(/^\.?\/+/, '').replace(/\\/g, '/');
    const content = byPath.get(path);
    if (content === undefined) {
      if (edit.find === '') {
        byPath.set(path, edit.replace); // new file
        continue;
      }
      errors.push(`${path}: file not found`);
      continue;
    }
    const normalized = content.replace(/\r\n/g, '\n');
    const find = edit.find.replace(/\r\n/g, '\n');
    const first = normalized.indexOf(find);
    if (!find || first === -1) {
      errors.push(`${path}: "find" text not found: ${truncate(find, 160)}`);
      continue;
    }
    if (normalized.indexOf(find, first + 1) !== -1) {
      errors.push(`${path}: "find" text matches more than once; include more surrounding context`);
      continue;
    }
    byPath.set(path, normalized.slice(0, first) + edit.replace + normalized.slice(first + find.length));
  }

  const changed: string[] = [];
  const diffs: string[] = [];
  for (const [path, content] of byPath) {
    const before = original.get(path) ?? '';
    if (before.replace(/\r\n/g, '\n') !== content.replace(/\r\n/g, '\n')) {
      changed.push(path);
      diffs.push(unifiedDiff(path, before.replace(/\r\n/g, '\n'), content));
    }
  }
  return {
    files: [...byPath].map(([path, content]) => ({ path, content })),
    diff: diffs.join('\n'),
    changed,
    errors,
  };
}

/** Normalise an error into a short signature used for memory lookups. */
export function errorSignature(message: string, stack?: string): string {
  const firstFrame = stack
    ?.split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('at '));
  const file = firstFrame?.match(/([\w.-]+\/[\w.-]+\.m?[jt]sx?)(?::\d+)?/)?.[1] ?? firstFrame?.match(/([\w.-]+\.m?[jt]sx?)/)?.[1];
  const msg = message.replace(/https?:\/\/\S+/g, '<url>').replace(/\d{3,}/g, 'N').slice(0, 200);
  return file ? `${msg} @ ${file}` : msg;
}
