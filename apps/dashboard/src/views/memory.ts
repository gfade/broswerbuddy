// Memory view: the SurrealDB bug → fix graph, KPIs from /api/stats, score trend and heal-time bars.
import type { GraphNode } from '@healops/shared/types';
import { mountBars, mountTrend } from '../charts';
import { refreshGraph } from '../data';
import { legendHtml, mountGraph, NODE_STYLE } from '../graph';
import { emit, ui } from '../state';
import { esc, fmtSec, patchHtml, q } from '../util';

const SKELETON = `
<div class="view-inner memory">
  <div class="view-head">
    <div><h2>Memory</h2><p class="muted sm">Every bug the agent has seen, the fix that healed it, and the files it touched</p></div>
    <span class="grow"></span>
    <span class="pill" data-provider></span>
    <button class="btn" type="button" data-refresh>Refresh</button>
  </div>
  <div class="kpis" data-kpis></div>
  <div class="mem-grid">
    <section class="panel pad">
      <div class="row-gap"><span class="cap">Bug memory graph</span><span class="grow"></span><span data-legend></span></div>
      <div class="graph-host" data-graph></div>
    </section>
    <aside class="panel pad mem-side" data-node></aside>
  </div>
  <div class="mem-grid2">
    <section class="panel pad"><div class="cap">Fix quality (judge score)</div><div class="chart-host" data-trend></div></section>
    <section class="panel pad"><div class="cap">Time to heal (s)</div><div class="chart-host" data-bars></div></section>
  </div>
</div>`;

function kpi(label: string, value: string, note = ''): string {
  return `<div class="panel kpi"><span class="cap">${esc(label)}</span><b>${esc(value)}</b>${note ? `<span class="xs muted">${esc(note)}</span>` : ''}</div>`;
}

function nodeHtml(node: GraphNode | undefined): string {
  if (!node) return '<div class="cap">Selected node</div><p class="sm muted">Click a node in the graph to inspect it. Bugs link to the fixes that healed them; similar bugs link to each other.</p>';
  const rows = Object.entries(node.data ?? {})
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
    .map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="mono">${esc(k.endsWith('At') && typeof v === 'number' ? new Date(v).toLocaleString() : String(v))}</td></tr>`)
    .join('');
  return `<div class="cap">${esc(NODE_STYLE[node.type].label)}</div>
    <h3 class="drawer-title">${esc(node.label)}</h3>
    <p class="mono xs muted">${esc(node.id)}</p>
    ${rows ? `<table class="ut sm"><tbody>${rows}</tbody></table>` : ''}`;
}

export function mountMemory(root: HTMLElement): { update(): void; dispose(): void } {
  root.innerHTML = SKELETON;
  const $ = (sel: string): HTMLElement => q<HTMLElement>(root, sel);
  const kpis = $('[data-kpis]');
  const graphHost = $('[data-graph]');
  const nodeEl = $('[data-node]');
  const trendHost = $('[data-trend]');
  const barsHost = $('[data-bars]');
  const provider = $('[data-provider]');
  $('[data-legend]').innerHTML = legendHtml();
  let graphKey = '';
  let chartKey = '';
  let selected: GraphNode | undefined;
  let requested = false;

  function update(): void {
    if (root.hidden) return;
    if (!ui.graph && !requested) {
      requested = true;
      void refreshGraph();
    }
    const s = ui.stats;
    patchHtml(
      kpis,
      [
        kpi('Incidents', String(s?.incidents ?? '—')),
        kpi('Healed', String(s?.healed ?? '—')),
        kpi('Bugs in memory', String(s?.bugs ?? '—')),
        kpi('Fixes in memory', String(s?.fixes ?? '—')),
        kpi('Memory hits', String(s?.memoryHits ?? '—'), 'recall found a past fix'),
        kpi('Avg time to heal', s?.avgHealMs !== undefined ? fmtSec(s.avgHealMs) : '—'),
        kpi('Avg judge score', s?.avgScore !== undefined ? String(Math.round(s.avgScore)) : '—'),
      ].join(''),
    );
    const mem = ui.modes?.memory ?? '';
    provider.textContent = mem ? `SurrealDB · ${mem}` : 'SurrealDB';
    provider.style.setProperty('--c', 'var(--surreal)');

    const g = ui.graph;
    const key = g ? `${g.nodes.length}:${g.edges.length}` : '';
    if (g && key !== graphKey) {
      graphKey = key;
      mountGraph(graphHost, g, {
        selected: selected?.id,
        onSelect(node) {
          selected = node;
          patchHtml(nodeEl, nodeHtml(node));
        },
      });
    } else if (!g) {
      patchHtml(graphHost, '<div class="chart-empty">Loading the memory graph…</div>');
    }
    patchHtml(nodeEl, nodeHtml(selected));

    const closed = [...ui.incidents].filter((i) => i.closedAt !== undefined).sort((a, b) => a.openedAt - b.openedAt);
    const ck = closed.map((i) => `${i.id}:${i.score}:${i.healMs}`).join('|');
    if (ck !== chartKey) {
      chartKey = ck;
      mountTrend(trendHost, closed.filter((i) => i.score !== undefined).map((i) => ({ id: i.id, title: i.title, value: i.score as number })));
      mountBars(barsHost, closed.filter((i) => i.outcome === 'healed' && i.healMs !== undefined).map((i) => ({ id: i.id, title: i.title, value: (i.healMs as number) / 1000 })), 60);
    }
  }

  const onClick = (ev: Event): void => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (t?.closest('[data-refresh]')) {
      graphKey = '';
      void refreshGraph().then(emit);
    }
  };
  root.addEventListener('click', onClick);
  return { update, dispose: () => root.removeEventListener('click', onClick) };
}
