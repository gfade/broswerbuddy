// DOM, formatting and safety helpers shared by all views.
export type Attrs = Record<string, string | number | boolean | null | undefined>;
export type Kid = Node | string | number | false | null | undefined | readonly Kid[];

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape untrusted text (server data, labels from events) before it goes into an HTML string. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

function appendKids(parent: Node, kids: readonly Kid[]): void {
  for (const kid of kids) {
    if (kid === false || kid === null || kid === undefined) continue;
    if (Array.isArray(kid)) {
      appendKids(parent, kid as readonly Kid[]);
    } else if (typeof kid === 'string' || typeof kid === 'number') {
      parent.appendChild(document.createTextNode(String(kid)));
    } else {
      parent.appendChild(kid as Node);
    }
  }
}

function setAttrs(node: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
}

/** Build an HTML element. Text children become text nodes (safe for untrusted strings). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  setAttrs(node, attrs);
  appendKids(node, kids);
  return node;
}

/** Build an SVG element. */
export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...kids: Kid[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  setAttrs(node, attrs);
  appendKids(node, kids);
  return node;
}

export function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`missing element: ${selector}`);
  return node;
}

export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

const htmlCache = new WeakMap<Element, string>();
/** Replace an element's children only when the markup actually changed. Returns true when it did. */
export function patchHtml(node: Element, html: string): boolean {
  if (htmlCache.get(node) === html) return false;
  htmlCache.set(node, html);
  node.innerHTML = html;
  return true;
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${pad2(Math.round((ms % 60_000) / 1000))}s`;
}

export function fmtSec(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  return `${Math.round(ms / 1000)}s`;
}

/** mm:ss for live timers. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtAgo(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function fmtPct(v01: number): string {
  return `${Math.round(v01 * 100)}%`;
}

export function short(id: string | undefined, max = 14): string {
  if (!id) return '—';
  return id.length > max ? `${id.slice(0, max - 1)}…` : id;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Only http(s) links are rendered as anchors (server-provided URLs are untrusted). */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url, window.location.origin);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function debounce(fn: () => void, ms: number): () => void {
  let t = 0;
  return () => {
    window.clearTimeout(t);
    t = window.setTimeout(fn, ms);
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
