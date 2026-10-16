/**
 * Helpers shared by the SurrealDB and the in-memory providers, so both produce the same ids,
 * normalisation, graph and statistics.
 */
import { randomBytes } from 'node:crypto';
import {
  EMBED_DIM,
  type GraphEdge,
  type GraphNode,
  type IncidentSummary,
  type Memory,
  type MemoryGraph,
  type MemoryStats,
} from '@healops/shared';

/** A change notification as delivered by Memory.onChange (the argument of its listener). */
export type ChangeEvent = Parameters<Parameters<NonNullable<Memory['onChange']>>[0]>[0];

/** Per-table caps for graph(), keeping the dashboard graph readable (about 500 nodes). */
export const GRAPH_CAPS = { bug: 120, fix: 120, file: 120, flow: 40, incident: 100, edges: 500 } as const;

/** Relation tables, in the order graph() lists them. */
export const EDGE_TYPES = ['fixed_by', 'touches', 'detected_in', 'about', 'similar_to'] as const;

/** Time-sortable random key without a table prefix, e.g. "m3k2z9a_1f2e3d". */
export function newKey(): string {
  return `${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

/** Strip an optional "<table>:" prefix so callers may pass either "bug:x" or "x". */
export function bareKey(table: string, ref: string): string {
  const prefix = `${table}:`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

export function refString(table: string, key: string): string {
  return `${table}:${key}`;
}

/** Forward slashes, no leading "./" or "/". */
export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/** Record key for a file: the normalised path, percent-encoded ("js/cart.js" becomes "js%2Fcart.js"). */
export function fileKey(path: string): string {
  return encodeURIComponent(normalizePath(path));
}

export function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalizePath).filter((p) => p.length > 0))];
}

/** Embeddings must be EMBED_DIM finite, non-zero numbers; both providers refuse anything else. */
export function assertEmbedding(value: unknown, what: string): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== EMBED_DIM) {
    const got = Array.isArray(value) ? `${value.length} values` : typeof value;
    throw new Error(`${what}: embedding must be ${EMBED_DIM} finite numbers (got ${got})`);
  }
  if (!value.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new Error(`${what}: embedding must be ${EMBED_DIM} finite numbers`);
  }
  if (value.every((x) => x === 0)) {
    throw new Error(`${what}: embedding must not be all zeros`);
  }
}

/** Raw cosine similarity (-1..1). Zero vectors have no direction, so they score 0. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Similarity as reported to callers: 0..1, where negative cosines count as "not similar". */
export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

export function clampInt(x: number | undefined, min: number, max: number, fallback: number): number {
  const v = x !== undefined && Number.isFinite(x) ? Math.trunc(x) : fallback;
  return Math.min(max, Math.max(min, v));
}

/** Copy without undefined properties (SurrealDB would store them as NONE). */
export function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = v;
  }
  return out as T;
}

/** JSON-safe copy; anything that cannot be represented becomes an empty object. */
export function sanitize<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return {} as T;
  }
}

export function shorten(text: string, max = 90): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Incident fields that upsertIncident writes (everything except the id). */
export function incidentFields(inc: IncidentSummary): Partial<IncidentSummary> {
  return compact<Partial<IncidentSummary>>({
    title: inc.title,
    status: inc.status,
    source: inc.source,
    flowId: inc.flowId ? bareKey('flow', inc.flowId) : undefined,
    severity: inc.severity,
    openedAt: inc.openedAt,
    closedAt: inc.closedAt,
    outcome: inc.outcome,
    score: inc.score,
    memoryHit: inc.memoryHit,
    healMs: inc.healMs,
    bugId: inc.bugId,
    fixId: inc.fixId,
    traceId: inc.traceId,
    traceUrl: inc.traceUrl,
    error: inc.error,
  });
}

/** The incident fields that statistics are derived from. */
export interface IncidentStatRow {
  status?: string;
  outcome?: string;
  memoryHit?: string;
  healMs?: number;
  score?: number;
}

const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function mean(values: number[], digits: number): number | undefined {
  if (values.length === 0) return undefined;
  const avg = values.reduce((sum, x) => sum + x, 0) / values.length;
  const factor = 10 ** digits;
  return Math.round(avg * factor) / factor;
}

/** Dashboard statistics. Both providers call this, so their numbers agree. */
export function summarizeIncidents(rows: readonly IncidentStatRow[], bugs: number, fixes: number): MemoryStats {
  const healed = rows.filter((r) => r.status === 'healed' || r.outcome === 'healed');
  return compact<MemoryStats>({
    incidents: rows.length,
    healed: healed.length,
    bugs,
    fixes,
    memoryHits: rows.filter((r) => typeof r.memoryHit === 'string' && r.memoryHit.length > 0).length,
    rollbacks: rows.filter((r) => r.status === 'rolled_back' || r.outcome === 'rolled_back').length,
    avgHealMs: mean(healed.map((r) => r.healMs).filter(isNumber), 0),
    avgScore: mean(rows.map((r) => r.score).filter(isNumber), 1),
  });
}

/** Keeps only edges whose endpoints are present, and caps the edge count. */
export function buildGraph(nodes: GraphNode[], edges: GraphEdge[]): MemoryGraph {
  const ids = new Set(nodes.map((n) => n.id));
  return {
    nodes,
    edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)).slice(0, GRAPH_CAPS.edges),
  };
}
