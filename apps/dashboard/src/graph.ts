// Bug-memory graph: a small Fruchterman-Reingold layout drawn as SVG. Identity comes from shape AND
// colour (bug = circle, fix = square, file = chip, flow = diamond, incident = hollow ring), so colour is
// never the only channel. Hover highlights neighbours; click or Enter selects; a list view is the table twin.
import type { GraphEdge, GraphNode, MemoryGraph } from '@healops/shared/types';
import { Tip, mountChart } from './charts';
import { clamp, el, esc, svgEl } from './util';

export type NodeType = GraphNode['type'];

export const NODE_STYLE: Record<NodeType, { label: string; css: string }> = {
  bug: { label: 'Bug', css: 'var(--bad)' },
  fix: { label: 'Fix', css: 'var(--ok)' },
  file: { label: 'File', css: 'var(--info)' },
  flow: { label: 'Flow', css: 'var(--arize)' },
  incident: { label: 'Incident', css: 'var(--muted)' },
};

export const NODE_ORDER: NodeType[] = ['bug', 'fix', 'file', 'flow', 'incident'];

const W = 1000;
const H = 620;

/** Force-directed layout in a fixed 1000x620 space (deterministic: same graph, same picture). */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): Map<string, { x: number; y: number }> {
  const n = nodes.length;
  const pos = new Map<string, { x: number; y: number }>();
  const index = new Map<string, number>();
  nodes.forEach((node, i) => index.set(node.id, i));
  let seed = 1337;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  nodes.forEach((node, i) => {
    const a = (i / Math.max(1, n)) * Math.PI * 2;
    pos.set(node.id, {
      x: W / 2 + Math.cos(a) * W * 0.32 + (rnd() - 0.5) * 30,
      y: H / 2 + Math.sin(a) * H * 0.32 + (rnd() - 0.5) * 30,
    });
  });
  if (n < 2) return pos;

  const coords = nodes.map((node) => pos.get(node.id) ?? { x: W / 2, y: H / 2 });
  const k = Math.sqrt((W * H) / n);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  let temp = W / 8;
  for (let iter = 0; iter < 260; iter++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ax = coords[i].x - coords[j].x;
        const ay = coords[i].y - coords[j].y;
        const d = Math.sqrt(ax * ax + ay * ay) || 0.01;
        const f = (k * k) / d;
        dx[i] += (ax / d) * f;
        dy[i] += (ay / d) * f;
        dx[j] -= (ax / d) * f;
        dy[j] -= (ay / d) * f;
      }
    }
    for (const e of edges) {
      const i = index.get(e.from);
      const j = index.get(e.to);
      if (i === undefined || j === undefined || i === j) continue;
      const ax = coords[i].x - coords[j].x;
      const ay = coords[i].y - coords[j].y;
      const d = Math.sqrt(ax * ax + ay * ay) || 0.01;
      const f = (d * d) / k;
      dx[i] -= (ax / d) * f;
      dy[i] -= (ay / d) * f;
      dx[j] += (ax / d) * f;
      dy[j] += (ay / d) * f;
    }
    // gravity: keeps disconnected nodes (e.g. lone incidents) off the walls
    for (let i = 0; i < n; i++) {
      dx[i] += (W / 2 - coords[i].x) * 0.25;
      dy[i] += (H / 2 - coords[i].y) * 0.4;
    }
    for (let i = 0; i < n; i++) {
      const mag = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 0.01;
      const step = Math.min(mag, temp);
      coords[i].x = clamp(coords[i].x + (dx[i] / mag) * step, 40, W - 40);
      coords[i].y = clamp(coords[i].y + (dy[i] / mag) * step, 40, H - 40);
    }
    temp = Math.max(0.5, temp * 0.98);
  }
  nodes.forEach((node, i) => pos.set(node.id, coords[i]));
  return pos;
}

function shapeEl(type: NodeType): SVGElement {
  const css = NODE_STYLE[type].css;
  switch (type) {
    case 'bug':
      return svgEl('circle', { r: 7, fill: css, stroke: 'var(--panel)', 'stroke-width': 2 });
    case 'fix':
      return svgEl('rect', { x: -6, y: -6, width: 12, height: 12, rx: 3, fill: css, stroke: 'var(--panel)', 'stroke-width': 2 });
    case 'file':
      return svgEl('rect', { x: -44, y: -12, width: 88, height: 24, rx: 7, fill: 'var(--panel2)', stroke: css, 'stroke-width': 1.5 });
    case 'flow':
      return svgEl('path', { d: 'M0,-9 L9,0 L0,9 L-9,0 Z', fill: css, stroke: 'var(--panel)', 'stroke-width': 2 });
    default:
      return svgEl('circle', { r: 6, fill: 'none', stroke: css, 'stroke-width': 2 });
  }
}

/** Static legend shapes for the view header (same geometry as the graph). */
export function legendHtml(): string {
  const shape: Record<NodeType, string> = {
    bug: `<circle r="5" fill="var(--bad)"/>`,
    fix: `<rect x="-4.5" y="-4.5" width="9" height="9" rx="2" fill="var(--ok)"/>`,
    file: `<rect x="-7" y="-4.5" width="14" height="9" rx="2.5" fill="var(--panel2)" stroke="var(--info)" stroke-width="1.5"/>`,
    flow: `<path d="M0,-6 L6,0 L0,6 L-6,0 Z" fill="var(--arize)"/>`,
    incident: `<circle r="4.5" fill="none" stroke="var(--muted)" stroke-width="2"/>`,
  };
  const items = NODE_ORDER.map(
    (t) => `<span class="lg"><svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">${shape[t]}</svg>${esc(NODE_STYLE[t].label)}</span>`,
  ).join('');
  return `<div class="graph-legend" aria-label="Node types">${items}<span class="lg-note">shape and label carry identity too</span></div>`;
}

export interface GraphOptions {
  selected?: string;
  onSelect(node: GraphNode | undefined): void;
}

export function mountGraph(host: HTMLElement, graph: MemoryGraph, opts: GraphOptions): void {
  mountChart(host, (w) => drawGraph(host, graph, opts, w));
}

function shortLabel(label: string): string {
  return label.length > 28 ? `${label.slice(0, 27)}…` : label;
}

function drawGraph(host: HTMLElement, graph: MemoryGraph, opts: GraphOptions, width: number): void {
  if (graph.nodes.length === 0) {
    host.replaceChildren(el('div', { class: 'chart-empty' }, 'No memory yet. Heal an incident to start the graph.'));
    return;
  }
  const height = Math.max(340, Math.min(520, Math.round(width * 0.56)));
  const pos = layoutGraph(graph.nodes, graph.edges);
  const scale = Math.min((width - 40) / W, (height - 40) / H);
  const ox = (width - W * scale) / 2;
  const oy = (height - H * scale) / 2;
  const P = (id: string): { x: number; y: number } => {
    const p = pos.get(id) ?? { x: W / 2, y: H / 2 };
    return { x: ox + p.x * scale, y: oy + p.y * scale };
  };
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const adj = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    if (!adj.has(e.to)) adj.set(e.to, new Set());
    adj.get(e.from)?.add(e.to);
    adj.get(e.to)?.add(e.from);
  }

  const tip = new Tip(host);
  const svg = svgEl('svg', {
    class: 'chart graph',
    width,
    height,
    role: 'group',
    'aria-label': `Memory graph: ${graph.nodes.length} nodes, ${graph.edges.length} links`,
  });

  const edgeEls: { line: SVGLineElement; from: string; to: string }[] = [];
  for (const e of graph.edges) {
    if (!pos.has(e.from) || !pos.has(e.to)) continue;
    const a = P(e.from);
    const b = P(e.to);
    const line = svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `edge edge-${e.type}` });
    svg.append(line);
    edgeEls.push({ line, from: e.from, to: e.to });
  }

  const groups = new Map<string, SVGGElement>();
  for (const node of graph.nodes) {
    const p = P(node.id);
    const g = svgEl('g', {
      class: `gnode gn-${node.type}`,
      tabindex: 0,
      role: 'button',
      'aria-label': `${NODE_STYLE[node.type].label}: ${node.label}`,
      'data-id': node.id,
      transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`,
    });
    g.append(svgEl('circle', { r: 16, fill: 'transparent', class: 'hit' }));
    g.append(shapeEl(node.type));
    if (node.type === 'file') g.append(svgEl('text', { y: 4, 'text-anchor': 'middle', class: 'chip-label' }, node.label));
    else g.append(svgEl('text', { x: 13, y: 4, class: 'nlabel' }, shortLabel(node.label)));
    groups.set(node.id, g);
    svg.append(g);
  }

  let selected = opts.selected;
  const applySelection = (): void => {
    for (const [id, g] of groups) g.classList.toggle('sel', id === selected);
  };
  const highlight = (id: string | undefined): void => {
    const near = id ? adj.get(id) : undefined;
    for (const [nid, g] of groups) {
      const on = !!id && (nid === id || !!near?.has(nid));
      g.classList.toggle('dim', !!id && !on);
      g.classList.toggle('hot', nid === id);
    }
    for (const { line, from, to } of edgeEls) line.classList.toggle('hi', !!id && (from === id || to === id));
  };
  const idOf = (target: EventTarget | null): string | undefined => {
    const g = target instanceof Element ? target.closest<SVGGElement>('.gnode') : null;
    return g?.dataset.id;
  };
  const showTip = (id: string): void => {
    const node = byId.get(id);
    if (!node) return;
    const p = P(id);
    const degree = adj.get(id)?.size ?? 0;
    const rows = [
      { value: NODE_STYLE[node.type].label, label: 'type', css: NODE_STYLE[node.type].css },
      { value: String(degree), label: degree === 1 ? 'link' : 'links' },
    ];
    if (typeof node.data?.score === 'number') rows.push({ value: String(Math.round(node.data.score as number)), label: 'judge score (of 100)', css: undefined });
    tip.show(p.x, p.y, node.label, rows);
  };

  svg.addEventListener('pointerover', (ev) => {
    const id = idOf(ev.target);
    if (!id) return;
    highlight(id);
    showTip(id);
  });
  svg.addEventListener('pointerout', (ev) => {
    const from = idOf(ev.target);
    const to = idOf(ev.relatedTarget);
    if (from && from !== to) {
      highlight(selected);
      tip.hide();
    }
  });
  svg.addEventListener('focusin', (ev) => {
    const id = idOf(ev.target);
    if (!id) return;
    highlight(id);
    showTip(id);
  });
  svg.addEventListener('focusout', () => {
    highlight(selected);
    tip.hide();
  });
  const choose = (id: string | undefined): void => {
    if (!id) {
      selected = undefined;
      applySelection();
      opts.onSelect(undefined);
      return;
    }
    selected = selected === id ? undefined : id;
    applySelection();
    opts.onSelect(selected ? byId.get(selected) : undefined);
  };
  svg.addEventListener('click', (ev) => {
    const id = idOf(ev.target);
    if (id) choose(id);
    else if (ev.target === svg) choose(undefined);
  });
  svg.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const id = idOf(ev.target);
    if (!id) return;
    ev.preventDefault();
    choose(id);
  });

  applySelection();
  host.replaceChildren(svg, tip.node);
}
