/**
 * Smoke test for @healops/anchor. Run: npx tsx packages/anchor/scripts/smoke.ts
 *
 *  1. local: a page on http://localhost:4321 whose button throws TypeError: boom. A failing and a
 *     passing flow, both on the local browser (a localhost URL never goes to Anchor).
 *  2. anchor (only when ANCHOR_API_KEY is set): example.com in a cloud session, then the same URL
 *     with forceLocal:true. Timings are printed by the runner's logger.
 *
 * Exits non-zero if any check fails.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Locator, Request } from 'playwright-core';
import { Sessions, NotFoundError, createAnchorbrowserClient, type Client } from 'anchorbrowser';
import {
  errorMessage,
  loadConfig,
  type BrowserRunner,
  type FlowDefinition,
  type RunFlowOptions,
} from '@healops/shared';
import { createBrowserRunner } from '../src/index.js';

const cfg = loadConfig();
const PORT = 4321;
const LOCAL_BASE = `http://localhost:${PORT}`;
const ARTIFACTS_DIR = path.join(cfg.dataDir, 'anchor-smoke');
const DAYTONA_HEADER = 'x-daytona-skip-preview-warning';
const ACTIVE_STATES = new Set(['active', 'running', 'pending', 'starting', 'live']);

type SessionEvent = Parameters<NonNullable<RunFlowOptions['onSession']>>[0];

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
}

// ───────────────────────────── local page ─────────────────────────────

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>HealOps smoke store</title></head>
<body>
  <h1>Smoke store</h1>
  <button id="checkout" type="button">Checkout</button>
  <script>
    document.getElementById('checkout').addEventListener('click', function () {
      console.error('checkout: cart service unavailable');
      throw new TypeError('boom');
    });
  </script>
</body>
</html>`;

/** Daytona header values seen on requests for the local page. */
const localHeaders: string[] = [];

const server = http.createServer((req, res) => {
  if (req.url !== '/') {
    res.writeHead(404).end();
    return;
  }
  localHeaders.push(String(req.headers[DAYTONA_HEADER] ?? '(missing)'));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE_HTML);
});

// ───────────────────────────── flows ─────────────────────────────

async function expectText(locator: Locator, expected: string): Promise<void> {
  const text = (await locator.textContent()) ?? '';
  if (!text.includes(expected)) {
    throw new Error(`expected text "${expected}", got ${JSON.stringify(text.slice(0, 120))}`);
  }
}

/** Fails: the click throws TypeError: boom, so the confirmation never appears. */
const brokenFlow: FlowDefinition = {
  id: 'smoke-broken-checkout',
  name: 'Smoke: broken checkout',
  description: 'Clicking Checkout throws TypeError: boom and the confirmation never shows.',
  critical: false,
  async run(ctx) {
    await ctx.step('Open page', async () => {
      await ctx.page.goto(`${ctx.baseUrl}/`);
      await expectText(ctx.page.getByRole('heading', { name: 'Smoke store' }), 'Smoke store');
    });
    await ctx.step('Click broken button', async () => {
      await ctx.page.getByRole('button', { name: 'Checkout' }).click();
      await ctx.page.locator('#order-confirmed').waitFor({ state: 'visible', timeout: 3000 });
    });
  },
};

/** Passes: opens the page and checks the button without clicking it. */
const healthyFlow: FlowDefinition = {
  id: 'smoke-home',
  name: 'Smoke: home page',
  description: 'Opens the smoke store and checks the checkout button is visible.',
  critical: false,
  async run(ctx) {
    await ctx.step('Open page', async () => {
      await ctx.page.goto(`${ctx.baseUrl}/`);
      await expectText(ctx.page.getByRole('heading', { name: 'Smoke store' }), 'Smoke store');
    });
    await ctx.step('Checkout button visible', async () => {
      await ctx.page.getByRole('button', { name: 'Checkout' }).waitFor({ state: 'visible' });
    });
  },
};

/** Never finishes its second step, so the run timeout has to end it. */
const hangingFlow: FlowDefinition = {
  id: 'smoke-hang',
  name: 'Smoke: hanging flow',
  description: 'Waits for an element that never appears.',
  critical: false,
  async run(ctx) {
    await ctx.step('Open page', async () => {
      await ctx.page.goto(`${ctx.baseUrl}/`);
    });
    await ctx.step('Wait for missing element', async () => {
      await ctx.page.locator('#never-rendered').waitFor({ state: 'visible', timeout: 60_000 });
    });
  },
};

/** Daytona header values seen on main-frame navigations by the example.com flow. */
const navHeaders: string[] = [];

/**
 * Asserts the page title and body copy of example.com. The live page has no h1 at all (checked in
 * local Chromium and in an Anchor session), so the title and the body text stand in for the H1 check.
 */
const exampleFlow: FlowDefinition = {
  id: 'smoke-example-com',
  name: 'Smoke: example.com',
  description: 'Opens example.com and checks the page title and body copy.',
  critical: false,
  async run(ctx) {
    const onRequest = (request: Request) => {
      if (request.isNavigationRequest() && request.frame() === ctx.page.mainFrame()) {
        navHeaders.push(request.headers()[DAYTONA_HEADER] ?? '(missing)');
      }
    };
    ctx.page.on('request', onRequest);
    try {
      await ctx.step('Open example.com', async () => {
        await ctx.page.goto(ctx.baseUrl, { waitUntil: 'load' });
        const title = await ctx.page.title();
        if (title !== 'Example Domain') throw new Error(`unexpected title ${JSON.stringify(title)}`);
      });
      await ctx.step('Check page content', async () => {
        await expectText(ctx.page.locator('body'), 'This domain is for use in documentation examples');
      });
    } finally {
      ctx.page.off('request', onRequest);
    }
  },
};

// ───────────────────────────── sections ─────────────────────────────

async function localSection(runner: BrowserRunner): Promise<void> {
  console.log(`\n[1] local flows on ${LOCAL_BASE} (runner primary provider: ${runner.provider})`);
  const events: SessionEvent[] = [];
  const optionsFor = (label: string): RunFlowOptions => ({
    baseUrl: LOCAL_BASE,
    artifactsDir: ARTIFACTS_DIR,
    onSession: (info) => events.push(info),
    onStep: (step) =>
      console.log(
        `    ${label} step ${step.index} "${step.name}": ${step.ok ? 'ok' : `FAILED: ${step.error}`} (${step.durationMs} ms)`,
      ),
  });

  localHeaders.length = 0;
  const broken = await runner.runFlow(brokenFlow, optionsFor('A'));
  console.log(`    A finished in ${broken.durationMs} ms`);
  check('A (broken): ok is false', broken.ok === false);
  check('A: failedStep is 1', broken.failedStep === 1, String(broken.failedStep));
  check('A: ran on local (localhost URL)', broken.provider === 'local', broken.provider);
  check(
    'A: pageErrors contains boom',
    broken.pageErrors.some((e) => e.includes('boom')),
    broken.pageErrors[0]?.split('\n')[0],
  );
  check('A: error.message contains boom', Boolean(broken.error?.message.includes('boom')), broken.error?.message);
  check('A: error.stack is the page error stack', Boolean(broken.error?.stack?.includes('TypeError: boom')));
  check('A: consoleErrors captured', broken.consoleErrors.includes('checkout: cart service unavailable'));
  check(
    'A: step results are [ok, failed]',
    broken.steps.length === 2 && broken.steps[0]?.ok === true && broken.steps[1]?.ok === false,
  );
  check('A: screenshot exists', Boolean(broken.screenshotFile && fs.existsSync(broken.screenshotFile)), broken.screenshotFile);
  check('A: no session for a local run', broken.sessionId === undefined && events.every((e) => e.sessionId === undefined));
  check(
    'A: Daytona header reached the local server',
    localHeaders.length > 0 && localHeaders.every((h) => h === 'true'),
    localHeaders.join(','),
  );

  events.length = 0;
  localHeaders.length = 0;
  const healthy = await runner.runFlow(healthyFlow, optionsFor('B'));
  console.log(`    B finished in ${healthy.durationMs} ms`);
  check('B (healthy): ok is true', healthy.ok === true, healthy.error?.message);
  check('B: no page errors', healthy.pageErrors.length === 0);
  check('B: ran on local (localhost URL)', healthy.provider === 'local', healthy.provider);
  check('B: screenshot exists', Boolean(healthy.screenshotFile && fs.existsSync(healthy.screenshotFile)), healthy.screenshotFile);
  check(
    'B: Daytona header reached the local server',
    localHeaders.length > 0 && localHeaders.every((h) => h === 'true'),
    localHeaders.join(','),
  );

  const hung = await runner.runFlow(hangingFlow, { ...optionsFor('C'), timeoutMs: 2000 });
  console.log(`    C finished in ${hung.durationMs} ms`);
  check('C (timeout): ok is false', hung.ok === false);
  check(
    'C: error says the flow timed out after 2000 ms',
    Boolean(hung.error?.message.includes('timed out after 2000 ms')),
    hung.error?.message,
  );
  check('C: failedStep is the step in flight', hung.failedStep === 1, String(hung.failedStep));
  check('C: timed-out step recorded as failed', hung.steps[1]?.ok === false && Boolean(hung.steps[1]?.error?.includes('timed out')));
  check('C: returned promptly', hung.durationMs < 10_000, `${hung.durationMs} ms`);
  check('C: screenshot exists', Boolean(hung.screenshotFile && fs.existsSync(hung.screenshotFile)), hung.screenshotFile);
}

async function sessionStatus(client: Client, sessionId: string): Promise<string> {
  try {
    const res = await Sessions.getSession({ client, path: { session_id: sessionId } });
    return res.data?.status ?? 'unknown';
  } catch (err) {
    return err instanceof NotFoundError ? 'not found' : `lookup failed (${err instanceof Error ? err.name : 'error'})`;
  }
}

function isEnded(status: string): boolean {
  if (status === 'not found') return true;
  return status !== 'unknown' && !status.startsWith('lookup failed') && !ACTIVE_STATES.has(status.toLowerCase());
}

async function anchorSection(runner: BrowserRunner): Promise<void> {
  console.log('\n[2] anchor: https://example.com in a cloud session');
  if (!cfg.anchor.enabled || !cfg.anchor.apiKey) {
    console.log('  skipped: ANCHOR_API_KEY is not set');
    return;
  }
  const client = createAnchorbrowserClient({ auth: cfg.anchor.apiKey });

  const events: { info: SessionEvent; at: number }[] = [];
  const stepEnds: number[] = [];
  navHeaders.length = 0;
  const run = await runner.runFlow(exampleFlow, {
    baseUrl: 'https://example.com',
    artifactsDir: ARTIFACTS_DIR,
    onSession: (info) => events.push({ info, at: Date.now() }),
    onStep: (step) => {
      stepEnds.push(Date.now());
      console.log(`    step ${step.index} "${step.name}": ${step.ok ? 'ok' : `FAILED: ${step.error}`} (${step.durationMs} ms)`);
    },
  });
  console.log(`    total runFlow ${run.durationMs} ms`);
  check('anchor run: ok is true', run.ok, run.error?.message);
  check('anchor run: provider is anchor', run.provider === 'anchor', run.provider);
  check('anchor run: sessionId present', Boolean(run.sessionId), run.sessionId);
  check(
    'anchor run: liveViewUrl present',
    Boolean(run.liveViewUrl),
    run.liveViewUrl ? new URL(run.liveViewUrl).host : undefined,
  );
  check(
    'onSession fired once, with the anchor session',
    events.length === 1 && events[0]?.info.provider === 'anchor' && events[0]?.info.sessionId === run.sessionId,
  );
  check(
    'onSession fired before the first step finished',
    events.length === 1 && (events[0]?.at ?? Infinity) <= (stepEnds[0] ?? -1),
  );
  check(
    'Daytona header sent by the anchor context',
    navHeaders.length > 0 && navHeaders.every((h) => h === 'true'),
    navHeaders.join(','),
  );
  if (run.sessionId) {
    const status = await sessionStatus(client, run.sessionId);
    check('anchor session ended after the run', isEnded(status), `status=${status}`);
  }

  console.log('\n[2b] forceLocal:true on the same URL');
  const forcedEvents: SessionEvent[] = [];
  const forced = await runner.runFlow(exampleFlow, {
    baseUrl: 'https://example.com',
    artifactsDir: ARTIFACTS_DIR,
    forceLocal: true,
    onSession: (info) => forcedEvents.push(info),
  });
  check('forceLocal run: ok is true', forced.ok, forced.error?.message);
  check(
    'forceLocal run: provider local, no session',
    forced.provider === 'local' && forced.sessionId === undefined && forcedEvents.every((e) => e.provider === 'local'),
    forced.provider,
  );
}

async function fallbackSection(): Promise<void> {
  console.log('\n[2c] Anchor rejects the key: the run falls back to local');
  const rejecting = createBrowserRunner({ ...cfg, anchor: { enabled: true, apiKey: 'invalid-smoke-key' } });
  const events: SessionEvent[] = [];
  navHeaders.length = 0;
  try {
    const run = await rejecting.runFlow(exampleFlow, {
      baseUrl: 'https://example.com',
      artifactsDir: ARTIFACTS_DIR,
      onSession: (info) => events.push(info),
    });
    check('fallback run: ok is true', run.ok, run.error?.message);
    check('fallback run: provider local, no session', run.provider === 'local' && run.sessionId === undefined, run.provider);
    check(
      'fallback: onSession reported local (last event)',
      events.at(-1)?.provider === 'local',
      events.map((e) => e.provider).join(' -> '),
    );
    check(
      'fallback: Daytona header set on the local context',
      navHeaders.length > 0 && navHeaders.every((h) => h === 'true'),
      navHeaders.join(','),
    );
  } finally {
    await rejecting.close();
  }
}

async function main(): Promise<void> {
  console.log(`ANCHOR_API_KEY ${cfg.anchor.enabled ? 'present' : 'absent'}; artifacts in ${ARTIFACTS_DIR}`);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve());
  });
  const runner = createBrowserRunner(cfg);
  try {
    await localSection(runner);
    await anchorSection(runner);
    if (cfg.anchor.enabled) await fallbackSection();
  } finally {
    await runner.close();
    server.close();
    server.closeAllConnections();
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`smoke test crashed: ${errorMessage(err)}`);
  process.exitCode = 1;
});
