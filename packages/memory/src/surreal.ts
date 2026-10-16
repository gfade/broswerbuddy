/**
 * SurrealDB-backed Memory. One class serves both the embedded engine (persisted in-process) and
 * a Surreal Cloud or self-hosted endpoint over WebSocket or HTTP.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Features, RecordId, Surreal, Table, createRemoteEngines, type LiveSubscription } from 'surrealdb';
import {
  EMBED_DIM,
  createLogger,
  errorMessage,
  type BugRecord,
  type EvalResult,
  type FixRecord,
  type GraphEdge,
  type GraphNode,
  type HealOpsConfig,
  type IncidentOutcome,
  type IncidentSource,
  type IncidentStatus,
  type IncidentSummary,
  type Memory,
  type MemoryGraph,
  type MemoryStats,
  type Severity,
  type SimilarBug,
  type Stage,
} from '@healops/shared';
import {
  EDGE_TYPES,
  GRAPH_CAPS,
  assertEmbedding,
  bareKey,
  buildGraph,
  clamp01,
  clampInt,
  compact,
  fileKey,
  incidentFields,
  newKey,
  refString,
  sanitize,
  shorten,
  summarizeIncidents,
  uniquePaths,
  type ChangeEvent,
  type IncidentStatRow,
} from './common.js';

const log = createLogger('surreal');
const CONNECT_TIMEOUT_MS = 8_000;
const SETUP_TIMEOUT_MS = 12_000;
const WATCHED_TABLES = ['bug', 'fix', 'incident'] as const;

type Row = Record<string, unknown>;

/** Schema, idempotent. The embedding dimension is enforced by the column type. */
const SCHEMA_SQL = `
DEFINE TABLE IF NOT EXISTS incident SCHEMALESS;
DEFINE TABLE IF NOT EXISTS bug SCHEMALESS;
DEFINE FIELD IF NOT EXISTS embedding ON TABLE bug TYPE array<float, ${EMBED_DIM}>;
DEFINE INDEX IF NOT EXISTS bug_embedding_hnsw ON TABLE bug FIELDS embedding HNSW DIMENSION ${EMBED_DIM} DIST COSINE;
DEFINE TABLE IF NOT EXISTS fix SCHEMALESS;
DEFINE TABLE IF NOT EXISTS file SCHEMALESS;
DEFINE TABLE IF NOT EXISTS flow SCHEMALESS;
DEFINE TABLE IF NOT EXISTS eval SCHEMALESS;
DEFINE TABLE IF NOT EXISTS transition SCHEMALESS;
DEFINE TABLE IF NOT EXISTS similar_to TYPE RELATION IN bug OUT bug SCHEMALESS;
DEFINE TABLE IF NOT EXISTS fixed_by TYPE RELATION IN bug OUT fix SCHEMALESS;
DEFINE TABLE IF NOT EXISTS touches TYPE RELATION IN fix OUT file SCHEMALESS;
DEFINE TABLE IF NOT EXISTS detected_in TYPE RELATION IN bug OUT flow SCHEMALESS;
DEFINE TABLE IF NOT EXISTS about TYPE RELATION IN incident OUT bug SCHEMALESS;
`;

/** Table name from a "table:key" reference. Keys are passed as bindings, never spliced into SQL. */
function toRecord(ref: string): RecordId {
  const i = ref.indexOf(':');
  return new RecordId(ref.slice(0, i), ref.slice(i + 1));
}

/** "table:key" for a RecordId value (or an already-formatted string). */
function refOf(value: unknown): string {
  if (value instanceof RecordId) return `${value.table.name}:${String(value.id)}`;
  return typeof value === 'string' ? value : String(value);
}

/** The key part only, e.g. "inc_123" for incident:inc_123. */
function keyOf(value: unknown): string {
  if (value instanceof RecordId) return String(value.id);
  const ref = refOf(value);
  const i = ref.indexOf(':');
  return i < 0 ? ref : ref.slice(i + 1);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function toBug(row: Row): BugRecord {
  return compact<BugRecord>({
    id: refOf(row.id),
    incidentId: str(row.incidentId) ?? '',
    signature: str(row.signature) ?? '',
    flowId: str(row.flowId),
    errorMessage: str(row.errorMessage) ?? '',
    stack: str(row.stack),
    severity: (str(row.severity) ?? 'sev3') as Severity,
    createdAt: num(row.createdAt) ?? 0,
  });
}

function toFix(row: Row): FixRecord {
  return compact<FixRecord>({
    id: refOf(row.id),
    bugId: str(row.bugId) ?? '',
    incidentId: str(row.incidentId) ?? '',
    summary: str(row.summary) ?? '',
    rootCause: str(row.rootCause) ?? '',
    diff: str(row.diff) ?? '',
    files: Array.isArray(row.files) ? row.files.map(String) : [],
    verified: row.verified === true,
    deployed: row.deployed === true,
    score: num(row.score),
    createdAt: num(row.createdAt) ?? 0,
  });
}

function toIncident(row: Row): IncidentSummary {
  return compact<IncidentSummary>({
    id: keyOf(row.id),
    title: str(row.title) ?? '',
    status: (str(row.status) ?? 'open') as IncidentStatus,
    source: (str(row.source) ?? 'manual') as IncidentSource,
    flowId: str(row.flowId),
    severity: (str(row.severity) ?? 'sev3') as Severity,
    openedAt: num(row.openedAt) ?? 0,
    closedAt: num(row.closedAt),
    outcome: str(row.outcome) as IncidentOutcome | undefined,
    score: num(row.score),
    memoryHit: str(row.memoryHit),
    healMs: num(row.healMs),
    bugId: str(row.bugId),
    fixId: str(row.fixId),
    traceId: str(row.traceId),
    traceUrl: str(row.traceUrl),
    error: str(row.error),
  });
}

export class SurrealMemory implements Memory {
  readonly provider: 'surrealdb-cloud' | 'surrealdb-embedded';
  /** Only present when the connection supports LIVE queries (not over plain HTTP). */
  declare readonly onChange?: Memory['onChange'];

  private ready = false;
  private closed = false;
  private readonly stops = new Set<() => Promise<void>>();

  constructor(
    private readonly db: Surreal,
    provider: 'surrealdb-cloud' | 'surrealdb-embedded',
  ) {
    this.provider = provider;
    if (db.isFeatureSupported(Features.LiveQueries)) {
      this.onChange = (fn) => this.subscribe(fn);
    }
  }

  async init(): Promise<void> {
    if (this.ready) return;
    await this.exec(SCHEMA_SQL);
    this.ready = true;
  }

  async recordBug(input: Omit<BugRecord, 'id' | 'createdAt'> & { embedding: number[] }): Promise<BugRecord> {
    assertEmbedding(input.embedding, 'recordBug');
    const key = newKey();
    const createdAt = Date.now();
    const incidentId = bareKey('incident', input.incidentId);
    const flowId = input.flowId ? bareKey('flow', input.flowId) : undefined;
    const inc = new RecordId('incident', incidentId);
    const vars: Record<string, unknown> = {
      inc,
      bug: new RecordId('bug', key),
      data: compact({
        incidentId,
        signature: input.signature,
        flowId,
        errorMessage: input.errorMessage,
        stack: input.stack,
        severity: input.severity,
        createdAt,
        embedding: input.embedding,
      }),
      // A stub so the about-edge has an incident to point at; upsertIncident fills it in later.
      incStub: { id: inc, title: input.signature, status: 'open', source: 'manual', severity: input.severity, openedAt: createdAt },
    };
    const statements = [
      'BEGIN TRANSACTION;',
      'INSERT IGNORE INTO incident $incStub;',
      'CREATE $bug CONTENT $data;',
      'RELATE $inc->about->$bug;',
    ];
    if (flowId) {
      vars.flow = new RecordId('flow', flowId);
      vars.flowStub = { id: vars.flow, name: flowId };
      statements.push('INSERT IGNORE INTO flow $flowStub;', 'RELATE $bug->detected_in->$flow;');
    }
    statements.push('COMMIT TRANSACTION;');
    await this.exec(statements.join('\n'), vars);

    return compact<BugRecord>({
      id: refString('bug', key),
      incidentId,
      signature: input.signature,
      flowId,
      errorMessage: input.errorMessage,
      stack: input.stack,
      severity: input.severity,
      createdAt,
    });
  }

  async similarBugs(
    embedding: number[],
    opts: { limit?: number; minSimilarity?: number; excludeBugId?: string } = {},
  ): Promise<SimilarBug[]> {
    assertEmbedding(embedding, 'similarBugs');
    const limit = clampInt(opts.limit, 1, 50, 5);
    const minSimilarity = opts.minSimilarity ?? 0;
    const exclude = opts.excludeBugId ? refString('bug', bareKey('bug', opts.excludeBugId)) : undefined;

    // Brute-force cosine over every bug: exact, and the history stays small enough for it.
    const rows = await this.rows(
      `SELECT id, incidentId, signature, flowId, errorMessage, stack, severity, createdAt,
              vector::similarity::cosine(embedding, $vec) AS similarity,
              ->fixed_by->fix.* AS fixes
       FROM bug WHERE embedding IS NOT NONE
       ORDER BY similarity DESC, createdAt DESC`,
      { vec: embedding },
    );

    const out: SimilarBug[] = [];
    for (const row of rows) {
      const bug = toBug(row);
      if (bug.id === exclude) continue;
      const similarity = clamp01(num(row.similarity) ?? 0);
      if (similarity < minSimilarity) continue;
      const fixes = (Array.isArray(row.fixes) ? (row.fixes as Row[]).map(toFix) : []).sort(
        (a, b) => a.createdAt - b.createdAt,
      );
      out.push({ bug, similarity, fixes });
      if (out.length >= limit) break;
    }
    return out;
  }

  async linkSimilar(bugId: string, otherBugId: string, similarity: number): Promise<void> {
    const from = refString('bug', bareKey('bug', bugId));
    const to = refString('bug', bareKey('bug', otherBugId));
    if (from === to) return;
    await this.requireRecord(from, `unknown bug: ${bugId}`);
    await this.requireRecord(to, `unknown bug: ${otherBugId}`);
    // Replace any existing link, so repeated calls keep one edge per pair.
    await this.exec(
      `BEGIN TRANSACTION;
       DELETE similar_to WHERE in = $from AND out = $to;
       RELATE $from->similar_to->$to SET score = $score;
       COMMIT TRANSACTION;`,
      { from: toRecord(from), to: toRecord(to), score: clamp01(similarity) },
    );
  }

  async recordFix(input: Omit<FixRecord, 'id' | 'createdAt'>): Promise<FixRecord> {
    const bugRef = refString('bug', bareKey('bug', input.bugId));
    await this.requireRecord(bugRef, `unknown bug: ${input.bugId}`);
    const key = newKey();
    const createdAt = Date.now();
    const incidentId = bareKey('incident', input.incidentId);
    const files = uniquePaths(input.files);
    const vars: Record<string, unknown> = {
      fix: new RecordId('fix', key),
      bug: toRecord(bugRef),
      data: compact({
        bugId: bugRef,
        incidentId,
        summary: input.summary,
        rootCause: input.rootCause,
        diff: input.diff,
        files,
        verified: input.verified,
        deployed: input.deployed,
        score: input.score,
        createdAt,
      }),
    };
    const statements = ['BEGIN TRANSACTION;', 'CREATE $fix CONTENT $data;', 'RELATE $bug->fixed_by->$fix;'];
    files.forEach((filePath, i) => {
      vars[`file${i}`] = new RecordId('file', fileKey(filePath));
      vars[`path${i}`] = filePath;
      statements.push(`INSERT IGNORE INTO file { id: $file${i}, path: $path${i} };`, `RELATE $fix->touches->$file${i};`);
    });
    statements.push('COMMIT TRANSACTION;');
    await this.exec(statements.join('\n'), vars);

    return compact<FixRecord>({
      id: refString('fix', key),
      bugId: bugRef,
      incidentId,
      summary: input.summary,
      rootCause: input.rootCause,
      diff: input.diff,
      files,
      verified: input.verified,
      deployed: input.deployed,
      score: input.score,
      createdAt,
    });
  }

  async updateFix(id: string, patch: Partial<Pick<FixRecord, 'verified' | 'deployed' | 'score'>>): Promise<void> {
    const ref = refString('fix', bareKey('fix', id));
    const data = compact({ verified: patch.verified, deployed: patch.deployed, score: patch.score });
    const rows = await this.rows('UPDATE $fix MERGE $data RETURN AFTER', { fix: toRecord(ref), data });
    if (rows.length === 0) throw new Error(`unknown fix: ${id}`);
  }

  async upsertIncident(inc: IncidentSummary): Promise<void> {
    await this.exec('UPSERT $inc MERGE $data', {
      inc: new RecordId('incident', bareKey('incident', inc.id)),
      data: incidentFields(inc),
    });
  }

  async recordTransition(
    incidentId: string,
    stage: Stage,
    status: 'started' | 'completed' | 'failed',
    data?: Record<string, unknown>,
  ): Promise<void> {
    await this.exec('CREATE transition CONTENT $row', {
      row: {
        incidentId: bareKey('incident', incidentId),
        stage,
        status,
        data: sanitize(data ?? {}),
        occurredAt: Date.now(),
      },
    });
  }

  async recordEval(fixId: string, result: EvalResult): Promise<void> {
    const ref = refString('fix', bareKey('fix', fixId));
    await this.requireRecord(ref, `unknown fix: ${fixId}`);
    const fix = toRecord(ref);
    // The judge score also becomes the fix's score, so ranking by score reflects the latest eval.
    await this.exec(
      `BEGIN TRANSACTION;
       CREATE eval CONTENT $row;
       UPDATE $fix SET score = $score;
       COMMIT TRANSACTION;`,
      {
        row: {
          fix,
          score: result.score,
          rubric: sanitize(result.rubric),
          verdict: result.verdict,
          model: result.model,
          createdAt: Date.now(),
        },
        fix,
        score: result.score,
      },
    );
  }

  async listIncidents(limit = 50): Promise<IncidentSummary[]> {
    const rows = await this.rows('SELECT * FROM incident ORDER BY openedAt DESC LIMIT $limit', {
      limit: clampInt(limit, 1, 1000, 50),
    });
    return rows.map(toIncident);
  }

  async graph(): Promise<MemoryGraph> {
    const [bugs, fixes, files, flows, incidents] = await Promise.all([
      this.rows('SELECT id, incidentId, signature, flowId, severity, createdAt FROM bug ORDER BY createdAt DESC LIMIT $n', { n: GRAPH_CAPS.bug }),
      this.rows('SELECT id, bugId, summary, verified, deployed, score, createdAt FROM fix ORDER BY createdAt DESC LIMIT $n', { n: GRAPH_CAPS.fix }),
      this.rows('SELECT id, path FROM file ORDER BY path LIMIT $n', { n: GRAPH_CAPS.file }),
      this.rows('SELECT id, name FROM flow ORDER BY name LIMIT $n', { n: GRAPH_CAPS.flow }),
      this.rows('SELECT id, title, status, outcome, severity, openedAt FROM incident ORDER BY openedAt DESC LIMIT $n', { n: GRAPH_CAPS.incident }),
    ]);
    const nodes: GraphNode[] = [
      ...bugs.map((r): GraphNode => ({
        id: refOf(r.id),
        type: 'bug',
        label: shorten(str(r.signature) ?? refOf(r.id)),
        data: compact({ incidentId: str(r.incidentId), flowId: str(r.flowId), severity: str(r.severity), createdAt: num(r.createdAt) }),
      })),
      ...fixes.map((r): GraphNode => ({
        id: refOf(r.id),
        type: 'fix',
        label: shorten(str(r.summary) ?? refOf(r.id)),
        data: compact({ bugId: str(r.bugId), verified: r.verified === true, deployed: r.deployed === true, score: num(r.score) }),
      })),
      ...files.map((r): GraphNode => ({
        id: refOf(r.id),
        type: 'file',
        label: str(r.path) ?? keyOf(r.id),
        data: { path: str(r.path) ?? keyOf(r.id) },
      })),
      ...flows.map((r): GraphNode => ({
        id: refOf(r.id),
        type: 'flow',
        label: str(r.name) ?? keyOf(r.id),
        data: { name: str(r.name) ?? keyOf(r.id) },
      })),
      ...incidents.map((r): GraphNode => ({
        id: refOf(r.id),
        type: 'incident',
        label: shorten(str(r.title) ?? keyOf(r.id)),
        data: compact({ status: str(r.status), outcome: str(r.outcome), severity: str(r.severity), openedAt: num(r.openedAt) }),
      })),
    ];

    const edgeRows = await Promise.all(
      EDGE_TYPES.map((type) => this.rows(`SELECT in, out, score FROM ${type} LIMIT 1000`)),
    );
    const edges: GraphEdge[] = EDGE_TYPES.flatMap((type, i) =>
      edgeRows[i].map((r): GraphEdge =>
        compact<GraphEdge>({
          from: refOf(r.in),
          to: refOf(r.out),
          type,
          weight: type === 'similar_to' ? num(r.score) : undefined,
        }),
      ),
    );
    return buildGraph(nodes, edges);
  }

  async stats(): Promise<MemoryStats> {
    const [bugs, fixes, incidents] = await Promise.all([
      this.count('bug'),
      this.count('fix'),
      this.rows<IncidentStatRow>('SELECT status, outcome, memoryHit, healMs, score FROM incident'),
    ]);
    return summarizeIncidents(incidents, bugs, fixes);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.stops].map((stop) => stop()));
    await this.db.close();
  }

  private async subscribe(fn: (change: ChangeEvent) => void): Promise<() => void> {
    const subs: LiveSubscription[] = [];
    try {
      for (const table of WATCHED_TABLES) {
        const sub = await this.db.live(new Table(table));
        subs.push(sub);
        void this.pump(table, sub, fn);
      }
    } catch (err) {
      await Promise.allSettled(subs.map((s) => s.kill()));
      throw err;
    }
    const stop = async (): Promise<void> => {
      if (!this.stops.delete(stop)) return;
      await Promise.allSettled(subs.map((s) => s.kill()));
    };
    this.stops.add(stop);
    return () => {
      void stop();
    };
  }

  private async pump(table: string, sub: LiveSubscription, fn: (change: ChangeEvent) => void): Promise<void> {
    try {
      for await (const msg of sub) {
        if (msg.action === 'KILLED') break;
        try {
          fn({ table, action: msg.action, id: refOf(msg.recordId) });
        } catch (err) {
          log.warn(`onChange listener failed: ${errorMessage(err)}`);
        }
      }
    } catch (err) {
      if (!this.closed) log.warn(`live query on ${table} ended: ${errorMessage(err)}`);
    }
  }

  private async rows<T = Row>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> {
    const [result] = await this.db.query<[T[]]>(sql, vars).collect();
    return result ?? [];
  }

  private async exec(sql: string, vars: Record<string, unknown> = {}): Promise<void> {
    await this.db.query(sql, vars).collect();
  }

  private async count(table: 'bug' | 'fix'): Promise<number> {
    const rows = await this.rows<{ n?: number }>(`SELECT count() AS n FROM ${table} GROUP ALL`);
    return Number(rows[0]?.n ?? 0);
  }

  private async requireRecord(ref: string, message: string): Promise<void> {
    const rows = await this.rows('SELECT id FROM $r', { r: toRecord(ref) });
    if (rows.length === 0) throw new Error(message);
  }
}

// ───────────────────────────── opening a connection ─────────────────────────────

export type SurrealTarget = 'cloud' | 'embedded';

/**
 * Connects and returns an initialised SurrealMemory. Throws when SurrealDB cannot be used,
 * so the caller can fall back to another provider.
 */
export async function openSurrealMemory(cfg: HealOpsConfig, target: SurrealTarget): Promise<SurrealMemory> {
  return target === 'cloud'
    ? openCloud(cfg, cfg.surreal.namespace, cfg.surreal.database)
    : openEmbedded(cfg, cfg.surreal.namespace, cfg.surreal.database);
}

async function openCloud(cfg: HealOpsConfig, ns: string, dbName: string): Promise<SurrealMemory> {
  const url = cfg.surreal.url;
  if (!url) throw new Error('SURREAL_URL is not set');
  const host = safeHost(url);
  const db = new Surreal({ engines: createRemoteEngines() });
  try {
    // The SDK keeps retrying a refused connection indefinitely, so the first connect is bounded here.
    await withTimeout(db.connect(url), CONNECT_TIMEOUT_MS, `connect to ${host}`);
    const mem = await withTimeout(setupCloud(db, cfg, ns, dbName), SETUP_TIMEOUT_MS, `set up ${host}`);
    log.info(`memory provider: surrealdb-cloud (${ns}/${dbName} on ${host})`);
    return mem;
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  }
}

async function setupCloud(db: Surreal, cfg: HealOpsConfig, ns: string, dbName: string): Promise<SurrealMemory> {
  await db.use({ namespace: ns, database: dbName });
  const { token, username, password } = cfg.surreal;
  if (token) {
    await db.authenticate(token);
  } else if (username && password) {
    try {
      await db.signin({ namespace: ns, database: dbName, username, password });
    } catch {
      // Not a database-level user: try a root-level sign-in with the same credentials.
      await db.signin({ username, password });
    }
  }
  const mem = new SurrealMemory(db, 'surrealdb-cloud');
  await mem.init();
  return mem;
}

async function openEmbedded(cfg: HealOpsConfig, ns: string, dbName: string): Promise<SurrealMemory> {
  // Loaded here, not at module top, so a missing native addon only disables this provider.
  const { createNodeEngines, engineVersion } = await import('@surrealdb/node');
  const kvDir = path.join(cfg.dataDir, 'surreal');
  const rocksDir = path.join(cfg.dataDir, 'surreal-rocksdb');

  // SurrealKV first; RocksDB and then memory are fallbacks. The memory fallback is not persisted.
  // An absolute path goes right after the scheme with no "//": "surrealkv:C:/x" is the absolute
  // path C:/x, but "surrealkv://C:/x" is read as host "C" and resolves relative to the working
  // directory, which silently puts the store somewhere else.
  const attempts = [
    { engine: 'surrealkv', url: `surrealkv:${toUrlPath(kvDir)}`, location: kvDir, persistent: true },
    { engine: 'rocksdb', url: `rocksdb:${toUrlPath(rocksDir)}`, location: rocksDir, persistent: true },
    { engine: 'mem', url: 'mem://', location: 'memory', persistent: false },
  ];

  let lastError: unknown;
  for (const attempt of attempts) {
    const db = new Surreal({ engines: createNodeEngines() });
    try {
      await db.connect(attempt.url);
      await defineNamespaceDatabase(db, ns, dbName);
      // The first write has created the store: it must be where we asked for it.
      if (attempt.persistent && !fs.existsSync(attempt.location)) {
        throw new Error(`store was not created at ${attempt.location}`);
      }
      const mem = new SurrealMemory(db, 'surrealdb-embedded');
      await mem.init();
      if (attempt.persistent) {
        log.info(`memory provider: surrealdb-embedded (${attempt.engine} at ${attempt.location}, SurrealDB ${engineVersion()})`);
      } else {
        log.warn('memory provider: surrealdb-embedded in MEMORY mode (nothing is persisted between runs)');
      }
      return mem;
    } catch (err) {
      lastError = err;
      log.warn(`${attempt.engine} store unavailable: ${errorMessage(err)}`);
      await db.close().catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Root-level setup for the embedded engine, which runs without authentication. */
async function defineNamespaceDatabase(db: Surreal, ns: string, dbName: string): Promise<void> {
  const ident = (name: string): string => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid SurrealDB identifier: ${name}`);
    return name;
  };
  await db.query(`DEFINE NAMESPACE IF NOT EXISTS ${ident(ns)}`).collect();
  await db.use({ namespace: ns });
  await db.query(`DEFINE DATABASE IF NOT EXISTS ${ident(dbName)}`).collect();
  await db.use({ namespace: ns, database: dbName });
}

/** SurrealKV and RocksDB want forward slashes; the URL parser rejects backslashes. */
function toUrlPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'configured endpoint';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
