// App shell: top bar (brand, nav, connection + provider modes), the four views, the demo banner and toasts.
import './styles.css';
import { boot, connectLive, exitDemoMode, startDemoMode } from './data';
import { ROUTES, ROUTE_LABEL, type Route, subscribe, ui, emit } from './state';
import { esc, patchHtml, q } from './util';
import { mountFlows } from './views/flows';
import { mountIncidents } from './views/incidents';
import { mountLive } from './views/live';
import { mountMemory } from './views/memory';

const app = document.getElementById('app');
if (!app) throw new Error('#app missing');

app.innerHTML = `
<header class="topbar">
  <a class="brand" href="#live"><span class="logo-mark" aria-hidden="true">✚</span><b>HealOps</b><span class="muted sm">mission control</span></a>
  <nav class="nav" aria-label="Views">${ROUTES.map((r) => `<a href="#${r}" data-route="${r}">${esc(ROUTE_LABEL[r])}</a>`).join('')}</nav>
  <span class="grow"></span>
  <div class="modes" data-modes></div>
  <span class="pill" data-ws></span>
  <button class="btn sm" type="button" data-demo></button>
</header>
<div class="banner" data-offer hidden>
  <span>Can't reach the HealOps server.</span>
  <button class="btn sm primary" type="button" data-start-demo>Play the scripted demo</button>
  <button class="btn sm ghost" type="button" data-retry>Retry</button>
</div>
<main class="views">${ROUTES.map((r) => `<section class="view" data-view="${r}" hidden></section>`).join('')}</main>
<div class="toasts" aria-live="polite" data-toasts></div>`;

const mounts: Record<Route, (root: HTMLElement) => { update(): void; dispose(): void }> = {
  live: mountLive,
  incidents: mountIncidents,
  memory: mountMemory,
  flows: mountFlows,
};
const views = ROUTES.map((r) => {
  const root = q<HTMLElement>(app, `[data-view="${r}"]`);
  return { route: r, root, view: mounts[r](root) };
});

const wsEl = q<HTMLElement>(app, '[data-ws]');
const demoBtn = q<HTMLButtonElement>(app, '[data-demo]');
const modesEl = q<HTMLElement>(app, '[data-modes]');
const offer = q<HTMLElement>(app, '[data-offer]');
const toastsEl = q<HTMLElement>(app, '[data-toasts]');

function routeFromHash(): Route {
  const h = window.location.hash.replace(/^#/, '') as Route;
  return ROUTES.includes(h) ? h : 'live';
}

const WS_LABEL: Record<string, [string, string]> = {
  connecting: ['◌ connecting', 'var(--muted)'],
  live: ['● LIVE', 'var(--ok)'],
  reconnecting: ['◌ reconnecting', 'var(--warn)'],
  demo: ['▶ DEMO', 'var(--accent)'],
};

function modeChips(): string {
  const m = ui.modes;
  if (!m) return '';
  const chip = (label: string, live: boolean, css: string, title: string) =>
    `<span class="mode${live ? ' on' : ''}" style="--c:${css}" title="${esc(title)}">${esc(label)}</span>`;
  return [
    chip('Anchor', m.browser === 'anchor', 'var(--anchor)', `browser: ${m.browser}`),
    chip('Bedrock', m.llm !== 'offline', 'var(--aws)', `llm: ${m.llm} (${m.models.patch})`),
    chip('SurrealDB', m.memory !== 'in-memory', 'var(--surreal)', `memory: ${m.memory}`),
    chip('Daytona', m.sandbox === 'daytona', 'var(--daytona)', `sandbox: ${m.sandbox}`),
    chip('AWS', m.deploy === 'aws-s3', 'var(--aws)', `deploy: ${m.deploy}`),
    chip('Arize', m.telemetry === 'arize', 'var(--arize)', `telemetry: ${m.telemetry}`),
  ].join('');
}

function render(): void {
  ui.route = routeFromHash();
  for (const v of views) {
    v.root.hidden = v.route !== ui.route;
    if (!v.root.hidden) v.view.update();
  }
  for (const a of app!.querySelectorAll<HTMLElement>('[data-route]')) {
    a.classList.toggle('on', a.dataset.route === ui.route);
  }
  const [label, css] = WS_LABEL[ui.ws] ?? WS_LABEL.connecting;
  wsEl.textContent = label;
  wsEl.style.setProperty('--c', css);
  demoBtn.textContent = ui.mode === 'demo' ? 'Exit demo' : 'Scripted demo';
  patchHtml(modesEl, modeChips());
  offer.hidden = !ui.offerDemo || ui.mode === 'demo';
  patchHtml(toastsEl, ui.toasts.map((t) => `<div class="toast ${t.tone}">${esc(t.text)}</div>`).join(''));
}

subscribe(render);
window.addEventListener('hashchange', emit);
app.addEventListener('click', (ev) => {
  const t = ev.target instanceof Element ? ev.target : null;
  if (!t) return;
  if (t.closest('[data-demo]')) {
    if (ui.mode === 'demo') exitDemoMode();
    else startDemoMode('auto');
  } else if (t.closest('[data-start-demo]')) {
    startDemoMode('auto');
  } else if (t.closest('[data-retry]')) {
    ui.offerDemo = false;
    connectLive();
    emit();
  }
});

boot();
emit();
