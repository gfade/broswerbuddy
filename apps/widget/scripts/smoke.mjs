/**
 * Smoke test for the "🐞 Bugs?" widget. Build first, then run from the repo root:
 *   npm run build -w @healops/widget && node apps/widget/scripts/smoke.mjs
 *
 * Serves a checkout-like page with dist/healops.js on port 4351, mocks POST /api/flags and
 * GET /api/incidents/inc1, drives the widget with playwright-core chromium, and checks the
 * report payload and the "Fixed" toast. Exits 0 on success, 1 on any failure.
 */
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const PORT = 4351;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const bundlePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'healops.js');
const NOTE = 'The pay button does nothing after I apply a coupon';
const CARD_NUMBER = '4242 4242 4242 4242';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout (smoke)</title>
</head>
<body>
<h1>Checkout</h1>
<input data-testid="card" type="text" aria-label="Card number">
<button data-testid="pay-now" type="button">Pay now</button>
<script src="/widget/healops.js" data-endpoint="${ORIGIN}" defer></script>
</body>
</html>`;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

/** Mock state: every report received, and how many times the incident was polled. */
const mock = { flags: [], polls: 0 };

function sendJson(res, body) {
  res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function route(req, res, bundle) {
  const { pathname } = new URL(req.url ?? '/', ORIGIN);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
  } else if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
  } else if (req.method === 'GET' && pathname === '/widget/healops.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' }).end(bundle);
  } else if (req.method === 'POST' && pathname === '/api/flags') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    mock.flags.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    sendJson(res, { flagId: 'f1', quarantined: false, incidentId: 'inc1' });
  } else if (req.method === 'GET' && pathname === '/api/incidents/inc1') {
    mock.polls += 1;
    const healed = mock.polls > 2; // "healing" for the first 2 polls, "healed" on the 3rd
    sendJson(res, {
      id: 'inc1',
      title: 'Checkout: coupon breaks payment',
      status: healed ? 'healed' : 'healing',
      source: 'flag',
      severity: 'sev2',
      openedAt: Date.now(),
      events: healed ? [{ type: 'store.version', at: Date.now(), version: '1.4.3', url: `${ORIGIN}/store` }] : [],
    });
  } else {
    res.writeHead(404, CORS).end('not found');
  }
}

const pass = (what) => console.log(`  ok  ${what}`);

function check(ok, what) {
  if (!ok) throw new Error(`assertion failed: ${what}`);
  pass(what);
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function run() {
  const bundle = await readFile(bundlePath).catch(() => {
    throw new Error(`missing ${bundlePath} (run: npm run build -w @healops/widget)`);
  });

  const server = http.createServer((req, res) => {
    route(req, res, bundle).catch((err) => res.writeHead(500).end(String(err)));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });

  const watchdog = setTimeout(() => {
    console.error('smoke: FAIL - watchdog timeout (90s)');
    process.exit(1);
  }, 90_000);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => typeof window.HealOps === 'object', null, { timeout: 10_000 });
    check((await page.evaluate(() => window.HealOps.version)) === '0.1.0', 'window.HealOps.version is 0.1.0');

    // User activity: a click, and typing into a field whose value must never be recorded.
    await page.click('[data-testid=pay-now]');
    await page.fill('[data-testid=card]', CARD_NUMBER);

    // Errors: a console.error, then an uncaught exception (wait until the widget has seen it).
    await page.evaluate(() => console.error('TypeError: Cannot read properties of undefined (reading subtotal)'));
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          window.addEventListener('error', () => resolve(), { once: true });
          setTimeout(() => {
            throw new Error('checkout exploded');
          }, 0);
        }),
    );

    // Open the widget from its pill (Playwright locators pierce the open shadow root), type, send.
    await page.getByRole('button', { name: 'Bugs?' }).click();
    await page.locator('textarea').fill(NOTE);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await waitFor(() => mock.flags.length === 1, 10_000, 'POST /api/flags');
    const body = mock.flags[0];
    check(body.note === NOTE, 'note sent');
    check(body.url === `${ORIGIN}/`, 'url sent');
    check(Array.isArray(body.events) && body.events.length >= 2, 'session events sent');
    check(
      body.events.some((e) => e.type === 'click' && e.target === 'button[data-testid=pay-now]'),
      'click recorded with a target descriptor',
    );
    check(
      body.events.some((e) => e.type === 'input' && e.target === 'input[data-testid=card]'),
      'input recorded with a target descriptor',
    );
    check(!JSON.stringify(body).includes('4242'), 'typed input values never recorded');
    check(
      body.consoleErrors.some((m) => m.includes('Cannot read properties of undefined')),
      'console.error sent in consoleErrors',
    );
    check(body.consoleErrors.some((m) => m.includes('checkout exploded')), 'uncaught error sent with its stack');
    const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]);
    check(JSON.stringify(body.viewport) === JSON.stringify([w, h]), `viewport sent (${w}x${h})`);
    check(typeof body.userAgent === 'string' && body.userAgent.includes('Chrome'), 'userAgent sent');

    // Progress while healing (polls at 3s, 6s), then the healed toast (poll at 9s).
    await page.getByText('HealOps is on it').waitFor({ timeout: 5_000 });
    pass('shows "Thanks! HealOps is on it"');
    await page.getByText('Working on it').waitFor({ timeout: 6_000 });
    pass('shows progress text while healing');
    await page.getByText('Fixed in v1.4.3').waitFor({ timeout: 13_000 });
    pass('shows "Fixed in v1.4.3 ... thanks for reporting!" toast');
    check(mock.polls === 3, `polled every 3s until healed, then stopped (polls=${mock.polls})`);

    console.log('smoke: PASS');
  } finally {
    await browser?.close();
    server.closeAllConnections();
    server.close();
    clearTimeout(watchdog);
  }
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(`smoke: FAIL - ${err?.message ?? err}`);
    process.exit(1);
  },
);
