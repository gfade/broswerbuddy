/**
 * Smoke test for the LOL Store. Run from the repo root:
 *   npx tsx apps/demo-store/scripts/smoke.ts
 *
 * Serves the healthy store and each seeded variant on http://127.0.0.1:4311, runs every flow in a
 * local Chromium, checks that each seed breaks only its own flow for the intended reason, checks
 * that its offlineFix restores the healthy files exactly, and runs the unit tests in a sandbox laid
 * out like the agent's. Prints a results table and exits non-zero on any failure.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  applyEdits,
  errorMessage,
  loadConfig,
  type FlowDefinition,
  type FlowStepResult,
  type SourceFile,
} from '@healops/shared';
import { flows } from '../flows/index.js';
import { applySeed, loadSite, sandboxFiles, seeds, TEST_COMMAND } from '../src/index.js';

const HOST = '127.0.0.1';
const PORT = 4311;
/** Sub-paths the healthy store must also work under, since every URL in the site is relative. */
const BASE_PATHS = ['/releases/x', '/__canary/1.4.3'];

/** The failing step and the evidence that proves each seed breaks for its intended reason. */
const EXPECTED_FAILURES: Record<string, { step: string; evidence: RegExp }> = {
  'checkout-discount': {
    step: 'See order confirmation',
    evidence: /Cannot read properties of undefined \(reading 'subtotal'\)/,
  },
  'signup-plus-email': { step: 'See success message', evidence: /signup-success/ },
  'cart-overlay': { step: 'Add Pixel Tee to cart', evidence: /intercepts pointer events/ },
};

interface FlowOutcome {
  flowId: string;
  ok: boolean;
  steps: FlowStepResult[];
  failedStep?: string;
  /** Full error text, Playwright call log included. */
  error?: string;
  /** Uncaught page errors (window.onerror and unhandled rejections). */
  pageErrors: string[];
}

interface Row {
  scenario: string;
  check: string;
  expected: string;
  actual: string;
  result: 'OK' | 'FAIL';
}

const rows: Row[] = [];

function clip(text: string, max = 120): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function record(scenario: string, check: string, expected: string, actual: string, ok: boolean): void {
  rows.push({ scenario, check, expected, actual: clip(actual), result: ok ? 'OK' : 'FAIL' });
}

function describe(outcome: FlowOutcome): string {
  return outcome.ok
    ? `pass (${outcome.steps.length} steps)`
    : `fail at "${outcome.failedStep}": ${clip(outcome.error ?? '')}`;
}

function contentType(file: string): string {
  switch (path.posix.extname(file).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

/** Serves the current set of site files; the file set can be swapped between runs. */
function createStaticServer() {
  let assets = new Map<string, Buffer>();
  const server = http.createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url ?? '/', `http://${HOST}`).pathname);
    for (const mount of BASE_PATHS) {
      if (pathname === mount || pathname.startsWith(`${mount}/`)) {
        pathname = pathname.slice(mount.length) || '/';
        break;
      }
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const key = pathname.replace(/^\/+/, '');
    const body = assets.get(key);
    const headers = { 'Cache-Control': 'no-store' };
    if (body === undefined) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': contentType(key) });
    res.end(body);
  });
  return {
    setFiles(files: SourceFile[]): void {
      assets = new Map(files.map((file): [string, Buffer] => [file.path, Buffer.from(file.content, 'utf8')]));
    },
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, HOST, () => resolve());
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

type StaticServer = ReturnType<typeof createStaticServer>;

/** Minimal FlowDefinition runner: a fresh browser context per flow, timed steps, rethrown failures. */
async function runFlow(browser: Browser, flow: FlowDefinition, baseUrl: string): Promise<FlowOutcome> {
  const context = await browser.newContext();
  const page: Page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  const steps: FlowStepResult[] = [];
  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    const index = steps.length;
    const startedAt = Date.now();
    try {
      await fn();
      steps.push({ index, name, ok: true, durationMs: Date.now() - startedAt });
    } catch (err) {
      steps.push({ index, name, ok: false, durationMs: Date.now() - startedAt, error: errorMessage(err) });
      throw err;
    }
  };
  try {
    await flow.run({ page, baseUrl, step });
    return { flowId: flow.id, ok: true, steps, pageErrors };
  } catch (err) {
    return {
      flowId: flow.id,
      ok: false,
      steps,
      failedStep: steps.find((s) => !s.ok)?.name,
      error: errorMessage(err),
      pageErrors,
    };
  } finally {
    await context.close();
  }
}

async function runFlows(
  browser: Browser,
  server: StaticServer,
  files: SourceFile[],
  baseUrl: string,
): Promise<FlowOutcome[]> {
  server.setFiles(files);
  const outcomes: FlowOutcome[] = [];
  for (const flow of flows) outcomes.push(await runFlow(browser, flow, baseUrl));
  return outcomes;
}

interface UnitResult {
  ok: boolean;
  summary: string;
  output: string;
}

/** Lays the files out as the sandbox does and runs TEST_COMMAND there. */
function runUnitTests(sandboxDir: string, files: SourceFile[]): UnitResult {
  fs.rmSync(sandboxDir, { recursive: true, force: true });
  for (const file of sandboxFiles(files)) {
    const target = path.join(sandboxDir, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
  }
  const run = spawnSync(TEST_COMMAND, {
    cwd: sandboxDir,
    shell: true,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  // Node prints TAP ("# pass 9") when piped and its spec reporter ("ℹ pass 9") on a TTY.
  const count = (name: string): number =>
    Number(new RegExp(`^(?:# |ℹ )${name} (\\d+)$`, 'm').exec(output)?.[1] ?? Number.NaN);
  const tests = count('tests');
  const pass = count('pass');
  const fail = count('fail');
  return {
    ok: run.status === 0 && fail === 0 && pass > 0 && pass === tests,
    summary: `${pass}/${tests} pass`,
    output,
  };
}

function sameTree(actual: SourceFile[], expected: SourceFile[]): boolean {
  const normalize = (files: SourceFile[]) =>
    new Map(files.map((file): [string, string] => [file.path, file.content.replace(/\r\n/g, '\n')]));
  const a = normalize(actual);
  const b = normalize(expected);
  return a.size === b.size && [...a].every(([filePath, content]) => b.get(filePath) === content);
}

async function runChecks(browser: Browser, server: StaticServer, sandboxDir: string): Promise<void> {
  const healthy = loadSite();
  const baseUrl = `http://${HOST}:${PORT}`;

  // 1. The healthy store: every flow passes at the root and under sub-paths; unit tests pass.
  const healthyRuns = await runFlows(browser, server, healthy, baseUrl);
  for (const outcome of healthyRuns) {
    record('healthy', `flow ${outcome.flowId}`, 'pass', describe(outcome), outcome.ok);
  }
  const healthyErrors = healthyRuns.flatMap((o) => o.pageErrors);
  record('healthy', 'uncaught page errors', 'none', healthyErrors.join(' | ') || 'none', healthyErrors.length === 0);
  for (const mount of BASE_PATHS) {
    const runs = await runFlows(browser, server, healthy, `${baseUrl}${mount}`);
    const passed = runs.filter((o) => o.ok).length;
    const errors = runs.flatMap((o) => o.pageErrors);
    record(
      `healthy at ${mount}/`,
      'all flows',
      'all pass, no page errors',
      `${passed}/${runs.length} pass, ${errors.length} page errors`,
      passed === runs.length && errors.length === 0,
    );
  }
  const healthyTests = runUnitTests(sandboxDir, healthy);
  record('healthy', 'unit tests', 'pass', healthyTests.summary, healthyTests.ok);
  if (!healthyTests.ok) console.error(healthyTests.output);

  // 2. Each seed: only its own flow fails, for the intended reason; its offlineFix restores the site.
  for (const seed of seeds) {
    const buggy = applySeed(healthy, seed.id);
    const buggyRuns = await runFlows(browser, server, buggy, baseUrl);
    for (const outcome of buggyRuns) {
      const shouldFail = outcome.flowId === seed.flowId;
      record(seed.id, `flow ${outcome.flowId}`, shouldFail ? 'fail' : 'pass', describe(outcome), outcome.ok !== shouldFail);
    }

    const expected = EXPECTED_FAILURES[seed.id];
    const failing = buggyRuns.find((o) => o.flowId === seed.flowId);
    if (expected && failing) {
      const evidenceFound = expected.evidence.test([failing.error ?? '', ...failing.pageErrors].join('\n'));
      const matched = failing.failedStep === expected.step && evidenceFound;
      record(
        seed.id,
        'failure reason',
        `fails at "${expected.step}" with the seeded error`,
        `failed at "${failing.failedStep}"; seeded error ${evidenceFound ? 'found' : 'not found'}`,
        matched,
      );
    }

    const fix = applyEdits(buggy, seed.offlineFix.edits);
    record(
      seed.id,
      'offlineFix applies',
      'no errors',
      fix.errors.length > 0 ? fix.errors.join('; ') : `changed: ${fix.changed.join(', ')}`,
      fix.errors.length === 0,
    );
    const restored = sameTree(fix.files, healthy);
    record(seed.id, 'offlineFix restores healthy site', 'identical to healthy', restored ? 'identical' : 'differs', restored);

    const fixedRuns = await runFlows(browser, server, fix.files, baseUrl);
    const fixedPassed = fixedRuns.filter((o) => o.ok).length;
    const stillFailing = fixedRuns.filter((o) => !o.ok).map((o) => o.flowId);
    const fixedErrors = fixedRuns.flatMap((o) => o.pageErrors);
    record(
      `${seed.id} + offlineFix`,
      'all flows',
      'all pass, no page errors',
      stillFailing.length > 0
        ? `still failing: ${stillFailing.join(', ')}`
        : `${fixedPassed}/${fixedRuns.length} pass, ${fixedErrors.length} page errors`,
      stillFailing.length === 0 && fixedErrors.length === 0,
    );

    const buggyTests = runUnitTests(sandboxDir, buggy);
    record(seed.id, 'unit tests', 'pass', buggyTests.summary, buggyTests.ok);
    if (!buggyTests.ok) console.error(buggyTests.output);
    const fixedTests = runUnitTests(sandboxDir, fix.files);
    record(`${seed.id} + offlineFix`, 'unit tests', 'pass', fixedTests.summary, fixedTests.ok);
    if (!fixedTests.ok) console.error(fixedTests.output);
  }
}

async function main(): Promise<number> {
  const sandboxDir = path.join(loadConfig().dataDir, 'demo-store-smoke');
  const server = createStaticServer();
  let browser: Browser | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    await runChecks(browser, server, sandboxDir);
  } catch (err) {
    record('smoke', 'run', 'no exception', errorMessage(err), false);
  } finally {
    await browser?.close();
    await server.close();
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }

  console.log('\nHealOps demo-store smoke test\n');
  console.table(rows);
  const failures = rows.filter((row) => row.result === 'FAIL').length;
  console.log(`${rows.length - failures}/${rows.length} checks passed`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
