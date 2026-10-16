// Records the "shopper flags an XSS in search → HealOps fixes it" demo as MP4 + GIF.
//   1. start the server:  HEALOPS_NO_PATROL=1 HEALOPS_INITIAL_SEED=search-xss npx tsx apps/server/src/main.ts
//   2. node scripts/record-demo.mjs            → docs/demo/flag-search-xss.{mp4,gif}
// Left: the shopper's browser (with a drawn cursor, since headless Chromium has none). Right: mission control.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Playwright records video with its own ffmpeg build. If that exact revision is missing (Claude Code cloud
// preinstalls an older one that cannot read newer Playwright's stream), point Playwright at a shim directory
// whose ffmpeg is the system one.
function shimFfmpeg() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !fs.existsSync(base)) return;
  const browsers = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
  const want = `ffmpeg-${browsers.browsers.find((b) => b.name === 'ffmpeg').revision}`;
  if (fs.existsSync(path.join(base, want))) return;
  const system = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim();
  if (!system) return;
  const shim = path.join(ROOT, '.healops', 'pw-shim');
  fs.rmSync(shim, { recursive: true, force: true });
  fs.mkdirSync(path.join(shim, want), { recursive: true });
  for (const d of fs.readdirSync(base)) fs.symlinkSync(path.join(base, d), path.join(shim, d));
  fs.symlinkSync(system, path.join(shim, want, 'ffmpeg-linux'));
  fs.writeFileSync(path.join(shim, want, 'INSTALLATION_COMPLETE'), '');
  process.env.PLAYWRIGHT_BROWSERS_PATH = shim;
}
shimFfmpeg();
const { chromium } = await import('playwright-core');
const API = process.env.HEALOPS_API ?? 'http://localhost:8787';
const RAW = path.join(ROOT, '.healops', 'recording');
const OUT = path.join(ROOT, 'docs', 'demo');
const SIZE = { width: 1280, height: 800 };
const PAYLOAD = `<img src=x onerror="const b=document.querySelector('.promo-bar');b.textContent='💀 HACKED: your session cookie was sent to evil.example';b.style.cssText='background:#e11d48;color:#fff;font-size:22px;font-weight:800;padding:16px'">`;
const NOTE = 'Typing HTML into the search box runs it on the page and the whole store went weird. Looks like an XSS security hole.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, init) => {
  const res = await fetch(`${API}${p}`, init);
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
  return res.json();
};

/** Draws a cursor that follows the real mouse, with a ripple on click. Lives outside <body> so page filters don't touch it. */
const CURSOR = `(() => {
  if (window !== window.top) return;
  const mount = () => {
    const c = document.createElement('div');
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 9-6.5 1.6L9.6 19z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:none;filter:drop-shadow(0 2px 3px #0006)';
    const cap = document.createElement('div');
    cap.id = '__demo_caption';
    cap.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483646;pointer-events:none;max-width:86%;padding:12px 20px;border-radius:12px;background:#0b0e15e6;color:#fff;font:600 19px/1.35 Inter,system-ui,sans-serif;box-shadow:0 10px 30px #0006;opacity:0;transition:opacity .3s';
    document.documentElement.append(c, cap);
    addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #7c5cff;left:' + e.clientX + 'px;top:' + e.clientY + 'px;transition:transform .45s,opacity .45s';
      document.documentElement.append(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(1.8)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 500);
    }, true);
  };
  if (document.documentElement) mount(); else addEventListener('DOMContentLoaded', mount);
})();`;

function chromiumPath() {
  if (process.env.HEALOPS_CHROMIUM_PATH) return process.env.HEALOPS_CHROMIUM_PATH;
  try {
    if (fs.existsSync(chromium.executablePath())) return undefined;
  } catch {}
  return ['/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p));
}

/** Mouse with a remembered position so every move glides from where it was. */
function pointer(page) {
  let at = { x: SIZE.width / 2, y: SIZE.height / 2 };
  return {
    async to(locator, dx = 0, dy = 0) {
      const box = await locator.boundingBox();
      if (!box) throw new Error(`no box for ${locator}`);
      const x = box.x + box.width / 2 + dx;
      const y = box.y + box.height / 2 + dy;
      const dist = Math.hypot(x - at.x, y - at.y);
      await page.mouse.move(x, y, { steps: Math.max(12, Math.round(dist / 14)) });
      at = { x, y };
      await sleep(180);
    },
    async click(locator, dx, dy) {
      await this.to(locator, dx, dy);
      await page.mouse.down();
      await sleep(90);
      await page.mouse.up();
      await sleep(250);
    },
    async park() {
      await page.mouse.move(at.x, at.y);
    },
  };
}

async function caption(page, text) {
  await page.evaluate((t) => {
    const el = document.getElementById('__demo_caption');
    if (!el) return;
    el.textContent = t;
    el.style.opacity = t ? '1' : '0';
  }, text);
}

async function main() {
  fs.rmSync(RAW, { recursive: true, force: true });
  fs.mkdirSync(RAW, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const health = await api('/api/health');
  const storeUrl = health.liveUrl;
  await api('/api/seeds/search-xss/reseed', { method: 'POST' });

  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });
  const mk = async (name) => {
    const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: path.join(RAW, name), size: SIZE } });
    await ctx.addInitScript(CURSOR);
    const page = await ctx.newPage();
    return { ctx, page, created: Date.now() };
  };
  const dash = await mk('dashboard');
  const shop = await mk('store');

  await dash.page.goto(`${API}/#live`);
  await dash.page.waitForFunction(() => document.querySelector('[data-ws]')?.textContent?.includes('LIVE'), null, { timeout: 15000 });
  await shop.page.goto(`${storeUrl}/index.html`);
  await shop.page.getByTestId('product').first().waitFor();
  await shop.page.locator('#pill').waitFor();
  const ready = Date.now();
  const sm = pointer(shop.page);
  const dm = pointer(dash.page);
  await sm.park();
  await dm.park();

  // 1. the shopper finds the bug
  await caption(shop.page, 'A shopper searches the LOL Store…');
  await sleep(1200);
  const search = shop.page.getByTestId('search');
  await sm.click(search);
  await shop.page.keyboard.type('hoodie', { delay: 110 });
  await sleep(1100);
  await caption(shop.page, '…and notices the search box runs any HTML it is given (XSS)');
  await shop.page.keyboard.press('Control+A');
  await shop.page.keyboard.type(PAYLOAD, { delay: 16 });
  await sleep(2200);

  // 2. flag it with the widget
  await caption(shop.page, 'They report it with the 🐞 widget');
  await sm.click(shop.page.locator('#pill'));
  await sleep(500);
  await sm.click(shop.page.locator('#note'));
  await shop.page.keyboard.type(NOTE, { delay: 22 });
  await sleep(500);
  await sm.click(shop.page.locator('#send'));
  await caption(shop.page, 'HealOps replays the flow, patches the bug and ships the fix');
  const flagAt = Date.now();

  // 3. wait for the heal (the dashboard on the right follows it live)
  let incident;
  for (;;) {
    const list = await api('/api/incidents');
    incident = list.find((i) => i.openedAt >= flagAt - 5000 && i.flowId === 'search');
    if (incident && incident.closedAt) break;
    if (Date.now() - flagAt > 120_000) throw new Error('heal did not finish within 120s');
    await sleep(500);
  }
  console.log(`incident ${incident.id}: ${incident.status} in ${incident.healMs}ms`);
  await sleep(2500);

  // 4. show the patch on the dashboard
  await caption(shop.page, `Fixed and deployed in ${(incident.healMs / 1000).toFixed(1)}s, with no human in the loop`);
  await dm.click(dash.page.locator('[data-stage="4"]'));
  await sleep(3200);
  await dm.click(dash.page.locator('[data-stage="5"]'));
  await sleep(1500);

  // 5. the same query is now harmless
  await caption(shop.page, 'Same query on the new version: shown as plain text');
  await shop.page.reload();
  await shop.page.getByTestId('product').first().waitFor();
  await caption(shop.page, 'Same query on the new version: shown as plain text');
  await sm.park();
  await sm.click(search);
  await shop.page.keyboard.type(PAYLOAD, { delay: 6 });
  await sleep(1200);
  await sm.to(shop.page.getByTestId('no-results'), 0, 40);
  await sleep(3500);

  const videos = [await dash.page.video().path(), await shop.page.video().path()];
  await dash.ctx.close();
  await shop.ctx.close();
  await browser.close();
  const [dashVideo, shopVideo] = await Promise.all(videos.map(async (v) => v));
  const trim = (created) => ((ready - created) / 1000).toFixed(2);

  const mp4 = path.join(OUT, 'flag-search-xss.mp4');
  const gif = path.join(OUT, 'flag-search-xss.gif');
  const run = (args) => {
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
  };
  // shopper left, mission control right, both from the moment the pages were ready
  run([
    '-ss', trim(shop.created), '-i', shopVideo,
    '-ss', trim(dash.created), '-i', dashVideo,
    '-filter_complex', '[0:v][1:v]hstack=inputs=2:shortest=1,scale=1920:-2,format=yuv420p[v]',
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart', mp4,
  ]);
  run([
    '-i', mp4,
    '-vf', 'fps=10,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    gif,
  ]);
  for (const f of [mp4, gif]) console.log(`${path.relative(ROOT, f)}  ${(fs.statSync(f).size / 1e6).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
