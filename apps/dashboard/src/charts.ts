// Charts. String builders for small marks (ring, bars, meters, strips) and measured SVG charts with
// hover and focus. Tooltips enhance; every value is also in the table twin rendered by the view.
// Palette: sponsor identity colours, one series colour per chart, status colours only for status.
import type { EvalRubric, Sponsor } from '@healops/shared/types';
import { SPONSOR_INFO } from './constants';
import { el, esc, fmtMs, svgEl } from './util';

const RUBRIC_LABEL: [keyof EvalRubric, string][] = [
  ['correctness', 'Correctness'],
  ['minimality', 'Minimal diff'],
  ['testCoverage', 'Test coverage'],
  ['safety', 'Safety'],
  ['memoryUse', 'Memory use'],
];

// ---- HTML marks ----------------------------------------------------------------

/** Score ring (0-100). Proportional figures: this is a hero number, not a table column. */
export function scoreRingHtml(score: number | undefined, size = 116): string {
  const r = 46;
  const c = 2 * Math.PI * r;
  const v = score === undefined ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const label = score === undefined ? 'No score yet' : `Score ${Math.round(score)} out of 100`;
  const fg =
    score === undefined
      ? ''
      : `<circle class="ring-fg" cx="60" cy="60" r="${r}" fill="none" stroke="var(--arize)" stroke-width="10" stroke-linecap="round" transform="rotate(-90 60 60)" style="stroke-dasharray:${c.toFixed(1)};stroke-dashoffset:${(c * (1 - v)).toFixed(1)}"/>`;
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 120 120" role="img" aria-label="${esc(label)}"><circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--line)" stroke-width="10"/>${fg}<text x="60" y="67" text-anchor="middle" class="ring-val">${score === undefined ? '—' : Math.round(score)}</text></svg>`;
}

export function barRowHtml(label: string, v01: number, css: string, valueText: string): string {
  const w = Math.max(0, Math.min(1, v01)) * 100;
  return `<div class="bar-row"><div class="bar-row-h"><span>${esc(label)}</span><span class="mono">${esc(valueText)}</span></div><div class="bar" role="img" aria-label="${esc(`${label} ${valueText}`)}"><i style="--w:${w.toFixed(1)}%;--c:${css}"></i></div></div>`;
}

export function rubricHtml(rubric: EvalRubric): string {
  return RUBRIC_LABEL.map(([key, label]) => {
    const v = Math.max(0, Math.min(1, rubric[key]));
    return barRowHtml(label, v, 'var(--arize)', v.toFixed(2));
  }).join('');
}

export function meterHtml(v01: number, css: string, label: string): string {
  const w = Math.max(0, Math.min(1, v01)) * 100;
  return `<div class="meter" role="img" aria-label="${esc(label)}"><i style="--w:${w.toFixed(1)}%;--c:${css}"></i></div>`;
}

/** Last-N run history: one cell per run, oldest first. Passing and failing also carry text (title + summary). */
export function stripHtml(history: boolean[]): string {
  const passed = history.filter(Boolean).length;
  const cells = history
    .map((ok, i) => `<i class="${ok ? 'pass' : 'fail'}" title="run ${i + 1}: ${ok ? 'passed' : 'failed'}"></i>`)
    .join('');
  return `<div class="strip" role="img" aria-label="${esc(`${passed} of ${history.length} runs passed`)}">${cells}</div>`;
}

export function sparkHtml(values: number[], css: string, w = 110, h = 26): string {
  if (values.length < 2) return '';
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${((i * w) / (values.length - 1)).toFixed(1)},${(h - 3 - ((v - lo) / span) * (h - 6)).toFixed(1)}`);
  const last = pts[pts.length - 1].split(',');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="${css}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${last[0]}" cy="${last[1]}" r="4" fill="${css}" stroke="var(--panel)" stroke-width="2"/></svg>`;
}

export function diffHtml(diff: string): string {
  const lines = diff.split('\n').map((line) => {
    let cls = 'ctx';
    if (line.startsWith('+++') || line.startsWith('---')) cls = 'meta';
    else if (line.startsWith('@@')) cls = 'hunk';
    else if (line.startsWith('+')) cls = 'add';
    else if (line.startsWith('-')) cls = 'del';
    return `<div class="dl ${cls}">${esc(line) || '&nbsp;'}</div>`;
  });
  return `<div class="diff">${lines.join('')}</div>`;
}

// ---- measured SVG charts -------------------------------------------------------

type Draw = (width: number) => void;
interface Mounted {
  draw: Draw;
  width: number;
  observer: ResizeObserver;
}
const mounted = new WeakMap<HTMLElement, Mounted>();

/** Draw a chart at the host's measured width and redraw whenever that width changes. */
export function mountChart(host: HTMLElement, draw: Draw): void {
  let entry = mounted.get(host);
  if (!entry) {
    const observer = new ResizeObserver(() => {
      const current = mounted.get(host);
      const w = Math.floor(host.clientWidth);
      if (current && w > 0 && w !== current.width) {
        current.width = w;
        current.draw(w);
      }
    });
    entry = { draw, width: 0, observer };
    mounted.set(host, entry);
    observer.observe(host);
  }
  entry.draw = draw;
  const w = Math.floor(host.clientWidth);
  if (w > 0) {
    entry.width = w;
    draw(w);
  }
}

export interface TipRow {
  value: string;
  label: string;
  css?: string;
}

/** Tooltip: value first (strong), label second, swatch as the series key. Built with textContent. */
export class Tip {
  readonly node: HTMLDivElement;
  private readonly host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.node = el('div', { class: 'chart-tip', role: 'tooltip' });
    host.appendChild(this.node);
  }

  show(x: number, y: number, title: string, rows: TipRow[]): void {
    this.node.replaceChildren(
      el('div', { class: 'tip-title' }, title),
      ...rows.map((r) =>
        el('div', { class: 'tip-row' },
          el('i', { class: 'tip-key', style: r.css ? `background:${r.css}` : undefined }),
          el('b', null, r.value),
          el('span', null, r.label),
        ),
      ),
    );
    this.node.classList.add('on');
    const tw = this.node.offsetWidth;
    const th = this.node.offsetHeight;
    const hw = this.host.clientWidth;
    const left = Math.min(Math.max(4, x + 14), Math.max(4, hw - tw - 4));
    const top = Math.max(4, y - th - 12);
    this.node.style.transform = `translate(${left}px, ${top}px)`;
  }

  hide(): void {
    this.node.classList.remove('on');
  }
}

function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function hbarPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, h / 2, w));
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}

function emptyChart(host: HTMLElement, text: string): void {
  host.replaceChildren(el('div', { class: 'chart-empty' }, text));
}

export interface TrendPoint {
  id: string;
  title: string;
  value: number;
}

/** Line of fix-quality scores, one point per incident, oldest first. Crosshair snaps to the nearest point. */
export function mountTrend(host: HTMLElement, points: TrendPoint[]): void {
  mountChart(host, (w) => drawTrend(host, points, w));
}

function drawTrend(host: HTMLElement, pts: TrendPoint[], width: number): void {
  if (pts.length === 0) return emptyChart(host, 'No scored incidents yet');
  const H = 186;
  const padL = 40;
  const padR = 50;
  const padT = 16;
  const padB = 30;
  const plotW = Math.max(60, width - padL - padR);
  const plotH = H - padT - padB;
  const values = pts.map((p) => p.value);
  const lo = Math.max(0, Math.floor((Math.min(...values) - 6) / 10) * 10);
  const hi = 100;
  const y = (v: number): number => padT + plotH * (1 - (v - lo) / (hi - lo));
  const x = (i: number): number => padL + (pts.length === 1 ? plotW / 2 : (i * plotW) / (pts.length - 1));
  const base = padT + plotH;
  const last = pts.length - 1;
  const tip = new Tip(host);
  const svg = svgEl('svg', {
    class: 'chart',
    width,
    height: H,
    role: 'img',
    'aria-label': `Fix quality over ${pts.length} incidents, latest ${Math.round(values[last])}`,
  });

  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += 20) ticks.push(v);
  if (ticks[ticks.length - 1] !== hi) ticks.push(hi);
  for (const t of ticks) {
    svg.append(svgEl('line', { x1: padL, x2: padL + plotW, y1: y(t), y2: y(t), stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(svgEl('text', { x: padL - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'axis' }, String(t)));
  }

  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  svg.append(svgEl('polygon', { points: `${x(0)},${base} ${line} ${x(last)},${base}`, fill: 'var(--arize)', 'fill-opacity': 0.12 }));
  svg.append(svgEl('polyline', { points: line, fill: 'none', stroke: 'var(--arize)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  pts.forEach((p, i) => {
    svg.append(svgEl('circle', { cx: x(i), cy: y(p.value), r: 4, fill: 'var(--arize)', stroke: 'var(--panel)', 'stroke-width': 2 }));
  });
  svg.append(svgEl('text', { x: x(last) + 10, y: y(pts[last].value) + 4, class: 'end-label' }, String(Math.round(pts[last].value))));
  svg.append(svgEl('text', { x: x(0), y: H - 8, 'text-anchor': pts.length === 1 ? 'middle' : 'start', class: 'axis' }, `#${pts[0].id}`));
  if (pts.length > 1) svg.append(svgEl('text', { x: x(last), y: H - 8, 'text-anchor': 'end', class: 'axis' }, `#${pts[last].id}`));

  const cross = svgEl('line', { x1: 0, x2: 0, y1: padT, y2: base, stroke: 'var(--muted)', 'stroke-width': 1, visibility: 'hidden' });
  const dot = svgEl('circle', { cx: 0, cy: 0, r: 6, fill: 'var(--arize)', stroke: 'var(--panel)', 'stroke-width': 2, visibility: 'hidden' });
  const hit = svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
  svg.append(cross, dot, hit);
  hit.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const i = pts.length === 1 ? 0 : Math.min(last, Math.max(0, Math.round(((mx - padL) / plotW) * last)));
    const p = pts[i];
    cross.setAttribute('x1', String(x(i)));
    cross.setAttribute('x2', String(x(i)));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', String(x(i)));
    dot.setAttribute('cy', String(y(p.value)));
    dot.setAttribute('visibility', 'visible');
    tip.show(x(i), y(p.value), `#${p.id} · ${p.title}`, [{ value: String(Math.round(p.value)), label: 'fix quality score', css: 'var(--arize)' }]);
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hide();
  });
  host.replaceChildren(svg, tip.node);
}

export interface BarItem {
  id: string;
  title: string;
  value: number;
}

/** Time to heal per incident (seconds) with a solid 60s threshold line. Each bar is its own hover and focus target. */
export function mountBars(host: HTMLElement, items: BarItem[], target: number): void {
  mountChart(host, (w) => drawBars(host, items, target, w));
}

function drawBars(host: HTMLElement, items: BarItem[], target: number, width: number): void {
  if (items.length === 0) return emptyChart(host, 'No healed incidents yet');
  const H = 186;
  const padL = 40;
  const padR = 84;
  const padT = 22;
  const padB = 30;
  const plotW = Math.max(60, width - padL - padR);
  const plotH = H - padT - padB;
  const maxV = Math.max(target * 1.2, ...items.map((i) => i.value));
  const step = maxV > 150 ? 60 : 30;
  const yMax = Math.ceil(maxV / step) * step;
  const y = (v: number): number => padT + plotH * (1 - v / yMax);
  const base = padT + plotH;
  const slot = plotW / items.length;
  const bw = Math.min(24, slot * 0.6);
  const tip = new Tip(host);
  const svg = svgEl('svg', {
    class: 'chart',
    width,
    height: H,
    role: 'img',
    'aria-label': `Time to heal for ${items.length} incidents, target ${target} seconds`,
  });

  for (let v = 0; v <= yMax; v += step) {
    svg.append(svgEl('line', { x1: padL, x2: padL + plotW, y1: y(v), y2: y(v), stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(svgEl('text', { x: padL - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, `${v}s`));
  }
  // threshold: solid, labelled, in the right margin so it never collides with a bar
  svg.append(svgEl('line', { x1: padL, x2: padL + plotW, y1: y(target), y2: y(target), stroke: 'var(--warn)', 'stroke-width': 1.5 }));
  svg.append(svgEl('text', { x: padL + plotW + 8, y: y(target) + 4, class: 'axis' }, `${target}s target`));

  items.forEach((it, i) => {
    const bx = padL + i * slot + (slot - bw) / 2;
    const top = y(it.value);
    const g = svgEl('g', {
      class: 'bar-hit',
      tabindex: 0,
      role: 'img',
      'aria-label': `#${it.id} ${it.title}: ${Math.round(it.value)} seconds`,
    });
    g.append(svgEl('rect', { x: padL + i * slot, y: padT, width: slot, height: plotH, fill: 'transparent' }));
    g.append(svgEl('path', { d: barPath(bx, top, bw, base - top, 4), fill: 'var(--arize)', class: 'bar-fill' }));
    const show = (): void => {
      tip.show(bx + bw / 2, top, `#${it.id} · ${it.title}`, [{ value: `${Math.round(it.value)}s`, label: 'time to heal', css: 'var(--arize)' }]);
    };
    g.addEventListener('pointerenter', show);
    g.addEventListener('focus', show);
    g.addEventListener('pointerleave', () => tip.hide());
    g.addEventListener('blur', () => tip.hide());
    svg.append(g);
  });

  const lastIdx = items.length - 1;
  svg.append(
    svgEl('text', { x: padL + lastIdx * slot + slot / 2, y: y(items[lastIdx].value) - 7, 'text-anchor': 'middle', class: 'bar-val' }, `${Math.round(items[lastIdx].value)}s`),
  );
  svg.append(svgEl('text', { x: padL, y: H - 8, class: 'axis' }, `#${items[0].id}`));
  if (items.length > 1) svg.append(svgEl('text', { x: padL + plotW, y: H - 8, 'text-anchor': 'end', class: 'axis' }, `#${items[lastIdx].id}`));
  host.replaceChildren(svg, tip.node);
}

export interface WaterRow {
  name: string;
  sponsor?: Sponsor;
  startMs: number;
  endMs: number;
  status: string;
}

/** Span waterfall: rows positioned by start and end, coloured by sponsor. Legend appears for two or more sponsors. */
export function mountWaterfall(host: HTMLElement, rows: WaterRow[]): void {
  mountChart(host, (w) => drawWaterfall(host, rows, w));
}

function niceStep(span: number): number {
  for (const s of [100, 250, 500, 1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000]) {
    if (span / s <= 6) return s;
  }
  return 120_000;
}

function drawWaterfall(host: HTMLElement, rows: WaterRow[], width: number): void {
  if (rows.length === 0) return emptyChart(host, 'No spans recorded for this incident');
  const sponsors = [...new Set(rows.map((r) => r.sponsor).filter((s): s is Sponsor => s !== undefined))];
  const legend =
    sponsors.length >= 2
      ? el('div', { class: 'legend' }, ...sponsors.map((s) => el('span', { class: 'lg' }, el('i', { class: 'sw', style: `background:${SPONSOR_INFO[s].css}` }), SPONSOR_INFO[s].label)))
      : undefined;
  const rowH = 24;
  const labelW = Math.min(190, Math.floor(width * 0.4));
  const padR = 64;
  const axisH = 22;
  const H = axisH + rows.length * rowH + 6;
  const t0 = Math.min(...rows.map((r) => r.startMs));
  const t1 = Math.max(...rows.map((r) => r.endMs));
  const span = Math.max(1, t1 - t0);
  const plotW = Math.max(60, width - labelW - padR);
  const X = (t: number): number => labelW + ((t - t0) / span) * plotW;
  const tip = new Tip(host);
  const svg = svgEl('svg', {
    class: 'chart wf',
    width,
    height: H,
    role: 'img',
    'aria-label': `Span waterfall, ${rows.length} spans, ${fmtMs(span)} in total`,
  });

  const step = niceStep(span);
  for (let t = 0; t <= span; t += step) {
    svg.append(svgEl('line', { x1: X(t0 + t), x2: X(t0 + t), y1: axisH, y2: H, stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(svgEl('text', { x: X(t0 + t), y: axisH - 8, 'text-anchor': 'middle', class: 'axis' }, fmtMs(t)));
  }

  let longest = 0;
  rows.forEach((r, i) => {
    if (r.endMs - r.startMs > rows[longest].endMs - rows[longest].startMs) longest = i;
  });

  rows.forEach((r, i) => {
    const yy = axisH + i * rowH;
    const css = r.sponsor ? SPONSOR_INFO[r.sponsor].css : 'var(--muted)';
    const dur = Math.max(1, r.endMs - r.startMs);
    const bx = X(r.startMs);
    const bw = Math.max(2, X(r.endMs) - bx);
    const g = svgEl('g', { class: 'wf-row', tabindex: 0, role: 'img', 'aria-label': `${r.name}, ${fmtMs(dur)}` });
    g.append(svgEl('rect', { x: 0, y: yy, width, height: rowH, fill: 'transparent' }));
    g.append(svgEl('text', { x: 0, y: yy + 16, class: 'wf-label' }, r.name));
    g.append(svgEl('path', { d: hbarPath(bx, yy + 7, bw, 10, 4), fill: css, class: 'bar-fill' }));
    if (i === longest) g.append(svgEl('text', { x: bx + bw + 6, y: yy + 16, class: 'bar-val' }, fmtMs(dur)));
    const show = (): void => {
      tip.show(bx + bw / 2, yy, r.name, [
        { value: fmtMs(dur), label: 'duration', css },
        { value: r.sponsor ? SPONSOR_INFO[r.sponsor].label : 'unattributed', label: 'sponsor' },
        { value: r.status, label: 'status' },
      ]);
    };
    g.addEventListener('pointerenter', show);
    g.addEventListener('focus', show);
    g.addEventListener('pointerleave', () => tip.hide());
    g.addEventListener('blur', () => tip.hide());
    svg.append(g);
  });
  host.replaceChildren(...(legend ? [legend] : []), svg, tip.node);
}
