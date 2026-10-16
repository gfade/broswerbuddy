/**
 * Smoke test for the sandbox providers.
 *   npx tsx packages/daytona/scripts/smoke.ts [local|daytona]
 * Each provider gets one sandbox, which is destroyed in a finally block even when a check fails.
 */
import fs from 'node:fs';
import { Daytona, DaytonaNotFoundError } from '@daytonaio/sdk';
import { loadConfig, type HealOpsConfig, type Sandbox, type SandboxProvider } from '@healops/shared';
import { createSandboxProvider } from '../src/index.js';

const PREVIEW_PORT = 4331;
/** A directory argument (`tests/`) is run as a module on Node >= 21, so the glob form is used. */
const TEST_CMD = 'node --test tests/*.test.mjs';
const BYPASS_HEADER = 'X-Daytona-Skip-Preview-Warning';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const INDEX_HTML =
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>healops smoke</title></head>\n' +
  '<body><h1>HEALOPS-SMOKE-OK</h1></body></html>\n';
const PACKAGE_JSON = '{"type":"module"}\n';
const PASS_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('a: passes', () => { assert.equal(1 + 1, 2); });",
  '',
].join('\n');
const FAIL_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('b.test.mjs: deliberate failure', () => { assert.equal(1 + 1, 3); });",
  '',
].join('\n');

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

class Report {
  private readonly timings = new Map<string, number>();
  private readonly lines: string[] = [];
  failures = 0;

  constructor(private readonly name: string) {}

  note(text: string): void {
    this.lines.push(`  ${text}`);
  }

  check(label: string, ok: boolean, detail?: string): void {
    if (!ok) this.failures++;
    this.lines.push(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` [${detail}]` : ''}`);
  }

  async time<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      this.timings.set(key, (this.timings.get(key) ?? 0) + performance.now() - started);
    }
  }

  print(): void {
    const fmt = (ms: number) => (ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`);
    console.log(`== ${this.name} ==`);
    console.log(`  timings: ${[...this.timings].map(([k, ms]) => `${k} ${fmt(ms)}`).join(' | ')}`);
    for (const line of this.lines) console.log(line);
    console.log(`  RESULT: ${this.failures === 0 ? 'PASS' : `FAIL (${this.failures} check(s))`}`);
  }
}

async function runProvider(
  name: string,
  provider: SandboxProvider,
  isGone: (sb: Sandbox) => Promise<boolean>,
): Promise<boolean> {
  const r = new Report(name);
  let created: Sandbox | undefined;
  try {
    const box = await r.time('create', () =>
      provider.create({ label: 'smoke', incidentId: `smoke-${Date.now().toString(36)}` }),
    );
    created = box;
    r.note(`provider=${box.provider} sandbox=${box.id}`);

    await r.time('upload', () =>
      box.writeFiles([
        { path: 'site/index.html', content: INDEX_HTML },
        { path: 'tests/a.test.mjs', content: PASS_TEST },
        { path: 'package.json', content: PACKAGE_JSON },
      ]),
    );

    const version = await r.time('exec node --version', () => box.exec('node --version'));
    r.check('node --version exits 0', version.exitCode === 0, version.output.trim());

    const pass = await r.time('exec tests (pass)', () => box.exec(TEST_CMD, { timeoutSec: 120 }));
    r.check(`"${TEST_CMD}" exits 0`, pass.exitCode === 0, `exit ${pass.exitCode}`);

    await r.time('upload', () => box.writeFiles([{ path: 'tests/b.test.mjs', content: FAIL_TEST }]));
    const streamed: string[] = [];
    const fail = await r.time('exec tests (fail)', () =>
      box.exec(TEST_CMD, { timeoutSec: 120, onLine: (line) => streamed.push(line) }),
    );
    r.check(
      'failing test gives non-zero exit and output names b.test.mjs',
      fail.exitCode !== 0 && fail.output.includes('b.test.mjs'),
      `exit ${fail.exitCode}`,
    );
    const outputLines = fail.output
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.length > 0);
    r.check(
      'onLine delivered every output line',
      streamed.length > 0 && outputLines.every((line) => streamed.includes(line)),
      `${streamed.length} lines`,
    );

    const served = await r.time('serve', () => box.serveStatic('site', PREVIEW_PORT));
    r.note(`preview host=${new URL(served.url).hostname} public=${served.public}`);
    r.check('preview public flag matches provider', served.public === (name === 'daytona'));

    // Browser-like request with no bypass header: does Daytona's warning interstitial replace the page?
    const bare = await fetch(`${served.url}/index.html`, { headers: { 'User-Agent': BROWSER_UA } });
    const bareBody = await bare.text();
    r.note(
      `browser UA, no ${BYPASS_HEADER}: HTTP ${bare.status}, warning page ${bareBody === INDEX_HTML ? 'not shown' : 'SHOWN'}`,
    );

    // The same request with the bypass header must return the uploaded index.html exactly.
    const res = await fetch(`${served.url}/index.html`, {
      headers: { 'User-Agent': BROWSER_UA, [BYPASS_HEADER]: 'true' },
    });
    const body = await res.text();
    r.check(
      'index.html with bypass header matches the uploaded file',
      res.status === 200 && body === INDEX_HTML,
      `HTTP ${res.status}, ${body.length} bytes`,
    );
    const cache = res.headers.get('cache-control') ?? '';
    r.check('response carries Cache-Control: no-store', cache.includes('no-store'), cache || 'missing');
  } catch (err) {
    r.check(`no unexpected error: ${msg(err)}`, false);
  } finally {
    if (created) {
      const box = created;
      try {
        await r.time('destroy', () => box.destroy());
        r.check('sandbox is gone after destroy', await isGone(box).catch(() => false));
      } catch (err) {
        r.check('sandbox destroyed', false, msg(err));
      }
    }
    r.print();
  }
  return r.failures === 0;
}

async function daytonaIsGone(cfg: HealOpsConfig, id: string): Promise<boolean> {
  const client = new Daytona({ apiKey: cfg.daytona.apiKey, apiUrl: cfg.daytona.apiUrl, target: cfg.daytona.target });
  try {
    return (await client.get(id)).state === 'destroyed';
  } catch (err) {
    return err instanceof DaytonaNotFoundError;
  }
}

async function main(): Promise<boolean> {
  const only = process.argv[2];
  const cfg = loadConfig();
  const results: boolean[] = [];

  if (!only || only === 'local') {
    const local = createSandboxProvider({ ...cfg, daytona: { ...cfg.daytona, enabled: false } });
    results.push(await runProvider('local', local, async (sb) => !fs.existsSync(sb.workdir)));
  }
  if (!only || only === 'daytona') {
    if (cfg.daytona.enabled) {
      results.push(await runProvider('daytona', createSandboxProvider(cfg), (sb) => daytonaIsGone(cfg, sb.id)));
    } else {
      console.log('== daytona ==\n  RESULT: FAIL (DAYTONA_API_KEY is not set)');
      results.push(false);
    }
  }

  const ok = results.length > 0 && results.every(Boolean);
  console.log(`SMOKE ${ok ? 'PASS' : 'FAIL'}`);
  return ok;
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
