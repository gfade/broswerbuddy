import path from 'node:path';
import type { SourceFile } from '@healops/shared';

/** Placeholder every store page carries where the feedback widget is injected. */
export const WIDGET_PLACEHOLDER = '<!--HEALOPS_WIDGET-->';

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$/;

export function isValidVersion(version: string): boolean {
  return VERSION_PATTERN.test(version);
}

/** Versions become directory names, object-key prefixes and URL segments, so the charset is fixed. */
export function assertVersion(version: string): void {
  if (!isValidVersion(version)) {
    throw new Error(
      `invalid version ${JSON.stringify(version)}: use up to 64 of [A-Za-z0-9._+~-], starting with a letter or digit`,
    );
  }
}

/**
 * Canonical relative path for a SourceFile: forward slashes, no leading "./" or "/".
 * Patch edits can name arbitrary paths, so anything that could leave the release is rejected.
 */
export function normalizeRelPath(raw: string): string {
  const segments = raw
    .replace(/\\/g, '/')
    .replace(/^(\.?\/)+/, '')
    .split('/')
    .filter((s) => s !== '.');
  if (segments.length === 0 || segments.some((s) => s === '' || s === '..' || s.includes(':') || s.includes('\0'))) {
    throw new Error(`invalid file path ${JSON.stringify(raw)}`);
  }
  return segments.join('/');
}

/** Validated, de-duplicated (last one wins) and sorted copy of a file list. */
export function normalizeFiles(files: SourceFile[]): SourceFile[] {
  const byPath = new Map<string, string>();
  for (const file of files) {
    if (typeof file.content !== 'string') throw new Error(`file ${JSON.stringify(file.path)} has no text content`);
    byPath.set(normalizeRelPath(file.path), file.content);
  }
  return [...byPath]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([filePath, content]) => ({ path: filePath, content }));
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.posix.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function isHtml(file: string): boolean {
  return /\.html?$/i.test(file);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Stored pages are pristine. Served pages get the widget script in place of the placeholder and
 * the version span stamped with the version being served.
 */
export function rewriteHtml(html: string, version: string, publicApiUrl: string): string {
  const api = escapeHtml(publicApiUrl.replace(/\/+$/, ''));
  const widget = `<script src="${api}/widget/healops.js" data-endpoint="${api}" defer></script>`;
  return html
    .split(WIDGET_PLACEHOLDER)
    .join(widget)
    .replace(
      /(<span\b(?=[^>]*\sid\s*=\s*["']version["'])[^>]*>)[\s\S]*?(<\/span\s*>)/gi,
      (_match, open: string, close: string) => `${open}${escapeHtml(`v${version}`)}${close}`,
    );
}

/** Decode one raw URL path segment into a single safe file or directory name, or undefined. */
export function decodeSegment(raw: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (decoded === '' || decoded === '.' || decoded === '..' || /[\\/:\0]/.test(decoded)) return undefined;
  return decoded;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
