/**
 * @healops/demo-store: the LOL Store demo site, its seeded bugs and the unit tests that ship with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceFile } from '@healops/shared';

export { seeds, DEFAULT_SEED, applySeed } from './seeds.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the healthy storefront (apps/demo-store/site). */
export const SITE_DIR = path.join(HERE, '..', 'site');
/** Absolute path of the unit tests (apps/demo-store/tests). */
export const TESTS_DIR = path.join(HERE, '..', 'tests');
export const SITE_VERSION = '1.4.2';
/**
 * Run from the sandbox root (the directory that contains site/ and tests/). Node 21+ no longer
 * accepts a bare directory ("node --test tests/" fails with "Cannot find module"), so the glob is
 * spelled out: POSIX shells expand it, and Node expands it itself on Windows.
 */
export const TEST_COMMAND = 'node --test tests/*.mjs';

function readTree(root: string, prefix: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) files.push({ path: `${prefix}${relPath}`, content: fs.readFileSync(abs, 'utf8') });
    }
  };
  walk(root, '');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Every file under site/, with forward-slash paths relative to the site root. */
export function loadSite(): SourceFile[] {
  return readTree(SITE_DIR, '');
}

/** Every file under tests/, with paths prefixed "tests/". */
export function loadTests(): SourceFile[] {
  return readTree(TESTS_DIR, 'tests/');
}

/**
 * Lay the store out like the sandbox: site files under site/, tests under tests/, a
 * package.json marking the directory as ESM, then `extra` (later entries win on path clashes).
 */
export function sandboxFiles(siteFiles: SourceFile[], extra: SourceFile[] = []): SourceFile[] {
  const files = new Map<string, string>();
  for (const file of siteFiles) files.set(`site/${file.path.replace(/^\/+/, '')}`, file.content);
  for (const file of loadTests()) files.set(file.path, file.content);
  files.set('package.json', '{"type":"module"}\n');
  for (const file of extra) files.set(file.path.replace(/^\.?\/+/, '').replace(/\\/g, '/'), file.content);
  return [...files].map(([filePath, content]) => ({ path: filePath, content }));
}
