#!/usr/bin/env node
/**
 * `npm run tunnel`: public URLs for the local store and API via Cloudflare quick tunnels.
 *
 *   node scripts/tunnel.mjs                start both tunnels and print their URLs
 *   node scripts/tunnel.mjs --write-env    also set HEALOPS_PUBLIC_STORE_URL and
 *                                          HEALOPS_PUBLIC_API_URL in .env
 *
 * Ports: HEALOPS_STORE_PORT (default 4000) and HEALOPS_SERVER_PORT (default 8787).
 * Quick-tunnel URLs change on every run. Ctrl+C stops both cloudflared processes.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const WRITE_ENV = process.argv.includes('--write-env');
const START_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 5_000;
// Quick-tunnel hostnames look like https://<random-words>.trycloudflare.com. The lookahead
// skips cloudflared's own API host, which it also logs as api.trycloudflare.com.
const TUNNEL_URL = /https:\/\/(?!api\.trycloudflare\.com)[a-z0-9-]+\.trycloudflare\.com/i;
const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');

const children = [];
let shuttingDown = false;

// ---- configuration -----------------------------------------------------------------

/** Reads only the named keys from .env. Other lines are never parsed or printed. */
function readEnvKeys(keys) {
  const found = {};
  if (!fs.existsSync(ENV_FILE)) return found;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && keys.includes(m[1])) found[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return found;
}

function portSetting(key, fallback) {
  const n = Number(process.env[key] || readEnvKeys([key])[key]);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

// ---- cloudflared lookup ------------------------------------------------------------

function findFile(dir, name, depth) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return full;
    if (entry.isDirectory() && depth > 0) {
      const hit = findFile(full, name, depth - 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** PATH first, then the WinGet link, then the WinGet package folder. */
function findCloudflared() {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  const link = path.join(localAppData, 'Microsoft', 'WinGet', 'Links', exe);
  if (fs.existsSync(link)) return link;
  const packages = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const pkg of fs.readdirSync(packages)) {
      if (!pkg.startsWith('Cloudflare.cloudflared')) continue;
      const hit = findFile(path.join(packages, pkg), exe, 2);
      if (hit) return hit;
    }
  } catch {
    // no WinGet packages folder
  }
  return undefined;
}

// ---- tunnels -----------------------------------------------------------------------

/** Starts one quick tunnel and resolves with its public URL once cloudflared prints it. */
function startTunnel(label, bin, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.push(child);

    let settled = false;
    let timer;
    let tail = '';
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const lastLines = () => tail.trim().split(/\r?\n/).slice(-3).join(' | ');

    const onData = (chunk) => {
      if (settled) return;
      tail = (tail + chunk.toString()).slice(-2000);
      const match = TUNNEL_URL.exec(tail);
      if (match) settle(resolve, { label, port, url: match[0] });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => settle(reject, err));
    child.once('exit', (code, signal) => {
      if (!settled) {
        settle(reject, new Error(`cloudflared exited (${code ?? signal}) before it printed a URL: ${lastLines()}`));
      } else if (!shuttingDown) {
        console.error(`[${label}] cloudflared stopped unexpectedly (${code ?? signal}); Ctrl+C to quit.`);
      }
    });
    timer = setTimeout(
      () => settle(reject, new Error(`no public URL after ${START_TIMEOUT_MS / 1000}s: ${lastLines()}`)),
      START_TIMEOUT_MS,
    );
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, SHUTDOWN_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nStopping tunnels (${reason})...`);
  await Promise.all(children.map(stopChild));
  console.log('Tunnels stopped.');
  process.exit(exitCode);
}

// ---- .env --------------------------------------------------------------------------

/**
 * Sets the given keys in .env and leaves every other byte as it was (line endings included).
 * Keys that are missing are appended. The file is replaced atomically, so a crash cannot
 * leave it half-written. Returns the keys that had to be appended.
 */
function writeEnvUrls(updates) {
  const raw = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const crlf = raw.includes('\r\n');
  const endsWithNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (endsWithNewline || raw === '') lines.pop(); // split() leaves an empty element after a final newline

  const seen = new Set();
  const next = lines.map((line) => {
    const cr = line.endsWith('\r') ? '\r' : '';
    const body = cr ? line.slice(0, -1) : line;
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(body)?.[1];
    if (key && Object.hasOwn(updates, key)) {
      seen.add(key);
      return `${key}=${updates[key]}${cr}`;
    }
    return line;
  });
  const appended = Object.keys(updates).filter((key) => !seen.has(key));
  for (const key of appended) next.push(`${key}=${updates[key]}${crlf ? '\r' : ''}`);

  let out = next.join('\n');
  if (endsWithNewline || raw === '' || appended.length > 0) out += '\n';
  const tmp = `${ENV_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, ENV_FILE);
  return appended;
}

// ---- main --------------------------------------------------------------------------

async function main() {
  const bin = findCloudflared();
  if (!bin) {
    console.error('cloudflared not found on PATH or in the WinGet folders.');
    console.error('Install it with: winget install --id Cloudflare.cloudflared');
    process.exitCode = 1;
    return;
  }

  const storePort = portSetting('HEALOPS_STORE_PORT', 4000);
  const apiPort = portSetting('HEALOPS_SERVER_PORT', 8787);
  console.log(`Starting quick tunnels with ${path.basename(bin)}: store :${storePort}, API :${apiPort}`);

  const [store, api] = await Promise.all([
    startTunnel('store', bin, storePort),
    startTunnel('api', bin, apiPort),
  ]);

  console.log('');
  console.log(`  store  http://localhost:${store.port}  ->  ${store.url}`);
  console.log(`  api    http://localhost:${api.port}  ->  ${api.url}`);
  console.log('');
  if (WRITE_ENV) {
    const appended = writeEnvUrls({ HEALOPS_PUBLIC_STORE_URL: store.url, HEALOPS_PUBLIC_API_URL: api.url });
    const note = appended.length ? ` (appended: ${appended.join(', ')})` : '';
    console.log(`Wrote HEALOPS_PUBLIC_STORE_URL and HEALOPS_PUBLIC_API_URL to .env${note}.`);
  } else {
    console.log('Next steps: set these in .env (or rerun with --write-env to do it for you):');
    console.log(`  HEALOPS_PUBLIC_STORE_URL=${store.url}   store address, used by Anchor's cloud browser`);
    console.log(`  HEALOPS_PUBLIC_API_URL=${api.url}   API address baked into the deployed store HTML`);
  }
  console.log('\nTunnels are live. Press Ctrl+C to stop both.');
}

process.on('SIGINT', () => void shutdown('Ctrl+C'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => void shutdown('Ctrl+Break'));
  process.on('SIGHUP', () => void shutdown('console closed'));
}
// Last resort on any normal exit path: never leave cloudflared running.
process.on('exit', () => {
  for (const child of children) if (child.exitCode === null) child.kill();
});

main().catch((err) => {
  console.error(`tunnel: ${err.message}`);
  void shutdown('startup failed', 1);
});
