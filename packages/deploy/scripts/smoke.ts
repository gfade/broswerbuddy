/**
 * Local deploy smoke test: bootstrap -> canary -> promote -> rollback -> publish -> close -> restart.
 *
 *   npx tsx packages/deploy/scripts/smoke.ts
 *
 * Uses port 4341 and <dataDir>/deploy-smoke, both cleaned up afterwards. S3 and the public store
 * URL from .env are overridden, so this never touches AWS. Exits 1 on any failed check.
 */
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { loadConfig, type Deployer, type HealOpsConfig, type SourceFile } from '@healops/shared';
import { createDeployer } from '../src/index.js';

const PORT = 4341;
const base = loadConfig();
const SMOKE_DIR = path.join(base.dataDir, 'deploy-smoke');
const cfg: HealOpsConfig = {
  ...base,
  storePort: PORT,
  dataDir: SMOKE_DIR,
  publicStoreUrl: undefined,
  aws: { ...base.aws, enabled: false, s3Bucket: undefined },
};
const apiBase = cfg.publicApiUrl.replace(/\/+$/, '');
const WIDGET_TAG = `<script src="${apiBase}/widget/healops.js" data-endpoint="${apiBase}" defer></script>`;

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  [${detail}]` : ''}`);
}

/** Two-file site. The build number appears in the page and in the JS, so a fetch shows which version answered. */
function site(build: number): SourceFile[] {
  return [
    {
      path: 'index.html',
      content: [
        '<!doctype html>',
        '<html lang="en">',
        '<head><meta charset="utf-8"><title>Smoke store</title><script src="js/app.js" defer></script></head>',
        '<body>',
        `  <h1>Smoke store build ${build}</h1>`,
        '  <p>Served version: <span id="version">dev</span></p>',
        '  <!--HEALOPS_WIDGET-->',
        '</body>',
        '</html>',
        '',
      ].join('\n'),
    },
    { path: 'js/app.js', content: `console.log('smoke build ${build}');\n` },
  ];
}

const heading = (build: number): string => `<h1>Smoke store build ${build}</h1>`;

async function get(url: string): Promise<{ status: number; type: string; cacheControl: string | null; body: string }> {
  const res = await fetch(url);
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    cacheControl: res.headers.get('cache-control'),
    body: await res.text(),
  };
}

function sortByPath(files: SourceFile[]): SourceFile[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function sameFiles(actual: SourceFile[], expected: SourceFile[]): boolean {
  const a = sortByPath(actual);
  const e = sortByPath(expected);
  return a.length === e.length && a.every((f, i) => f.path === e[i].path && f.content === e[i].content);
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  await rm(SMOKE_DIR, { recursive: true, force: true });
  const deployer = createDeployer(cfg);
  let restarted: Deployer | undefined;
  try {
    check('createDeployer selects the local host', deployer.provider === 'local', deployer.provider);
    check(`liveUrl is http://localhost:${PORT}`, deployer.liveUrl() === `http://localhost:${PORT}`, deployer.liveUrl());
    check('currentVersion is empty before bootstrap', (await deployer.currentVersion()) === '');

    // bootstrap v1.0.0
    await deployer.bootstrap(site(100), '1.0.0');
    const live100 = await get(`${deployer.liveUrl()}/`);
    check(
      'live index is served as text/html with 200',
      live100.status === 200 && live100.type.startsWith('text/html'),
      `${live100.status} ${live100.type}`,
    );
    check('live index includes the widget script tag', live100.body.includes(WIDGET_TAG));
    check('widget placeholder is replaced', !live100.body.includes('<!--HEALOPS_WIDGET-->'));
    check('version span reads v1.0.0', live100.body.includes('<span id="version">v1.0.0</span>'));
    check('pages are Cache-Control: no-store', live100.cacheControl === 'no-store', String(live100.cacheControl));
    check('currentVersion is 1.0.0', (await deployer.currentVersion()) === '1.0.0');

    // stage canary v1.0.1
    const { canaryUrl } = await deployer.stageCanary('1.0.1', site(101));
    check('canaryUrl is <liveUrl>/__canary/1.0.1', canaryUrl === `${deployer.liveUrl()}/__canary/1.0.1`, canaryUrl);
    const canary = await get(canaryUrl);
    check(
      'canary serves build 101 stamped v1.0.1',
      canary.body.includes(heading(101)) && canary.body.includes('<span id="version">v1.0.1</span>'),
      `status ${canary.status}`,
    );
    const canaryJs = await get(`${canaryUrl}/js/app.js`);
    check('canary relative asset comes from the canary', canaryJs.body.includes('smoke build 101'));
    check('live still serves build 100 during the canary', (await get(`${deployer.liveUrl()}/`)).body.includes(heading(100)));
    check('currentVersion still 1.0.0 after staging', (await deployer.currentVersion()) === '1.0.0');

    // promote
    await deployer.promote('1.0.1');
    check('promote: live serves build 101', (await get(`${deployer.liveUrl()}/`)).body.includes(heading(101)));
    check('promote: currentVersion is 1.0.1', (await deployer.currentVersion()) === '1.0.1');

    // rollback
    const { restoredVersion } = await deployer.rollback();
    check('rollback restores 1.0.0', restoredVersion === '1.0.0', restoredVersion);
    check('rollback: live serves build 100 again', (await get(`${deployer.liveUrl()}/`)).body.includes(heading(100)));

    // publish v1.0.2
    await deployer.publish(site(102), '1.0.2', 'smoke: forced publish');
    check('publish: live serves build 102', (await get(`${deployer.liveUrl()}/`)).body.includes(heading(102)));
    const versionEndpoint = await get(`${deployer.liveUrl()}/__version`);
    check('/__version reports 1.0.2', JSON.parse(versionEndpoint.body).version === '1.0.2', versionEndpoint.body);

    // history, newest first: publish 1.0.2, rollback to 1.0.0, promote 1.0.1, bootstrap 1.0.0
    const history = await deployer.history();
    const order = history.map((h) => h.version).join(' > ');
    check('history is newest first', order === '1.0.2 > 1.0.0 > 1.0.1 > 1.0.0', order);
    check('history keeps the publish note', history[0].note === 'smoke: forced publish', String(history[0].note));

    // liveFiles returns what was published, not the rewritten HTML
    check('liveFiles equals the published files (un-rewritten)', sameFiles(await deployer.liveFiles(), site(102)));

    // path traversal
    const escaped = await get(`${deployer.liveUrl()}/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json`);
    check('path traversal is refused', escaped.status === 404, String(escaped.status));
    const escapedCanary = await get(`${deployer.liveUrl()}/__canary/..%2f..`);
    check('canary version traversal is refused', escapedCanary.status === 404, String(escapedCanary.status));

    // close() must free the port
    await deployer.close();
    check('close() stops answering on the port', !(await answers(`http://localhost:${PORT}/`)));
    check('close() frees the port for a new server', await canBindPort(PORT));

    // restart: a new deployer on the same state keeps v1.0.2 live
    restarted = createDeployer(cfg);
    await restarted.bootstrap(site(100), '1.0.0');
    check('bootstrap after restart keeps 1.0.2 live', (await restarted.currentVersion()) === '1.0.2');
    check('restarted store serves build 102', (await get(`${restarted.liveUrl()}/`)).body.includes(heading(102)));
    await restarted.close();
  } catch (err) {
    failed += 1;
    console.error('FAIL  smoke crashed:', err);
  } finally {
    await deployer.close();
    await restarted?.close();
    await rm(SMOKE_DIR, { recursive: true, force: true });
  }
  console.log(failed === 0 ? '\nsmoke: all checks passed' : `\nsmoke: ${failed} check(s) failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
