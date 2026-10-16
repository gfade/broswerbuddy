/**
 * Pure TypeScript Memory with the same ids, semantics and statistics as the SurrealDB provider.
 * Used when SurrealDB cannot start. Nothing is persisted.
 */
import {
  createLogger,
  errorMessage,
  type BugRecord,
  type EvalResult,
  type FixRecord,
  type GraphEdge,
  type GraphNode,
  type IncidentSummary,
  type Memory,
  type MemoryGraph,
  type MemoryStats,
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
  cosine,
  fileKey,
  incidentFields,
  newKey,
  refString,
  sanitize,
  shorten,
  summarizeIncidents,
  uniquePaths,
  type ChangeEvent,
} from './common.js';

const log = createLogger('surreal');

interface BugRow extends BugRecord {
  embedding: number[];
}

interface EdgeRow {
  type: GraphEdge['type'];
  from: string;
  to: string;
  score?: number;
}

interface TransitionRow {
  incidentId: string;
  stage: Stage;
  status: 'started' | 'completed' | 'failed';
  data: Record<string, unknown>;
  occurredAt: number;
}

export class InMemoryMemory implements Memory {
  readonly provider = 'in-memory' as const;
  readonly onChange: NonNullable<Memory['onChange']>;

  private readonly incidents = new Map<string, IncidentSummary>();
  private readonly bugs = new Map<string, BugRow>();
  private readonly fixes = new Map<string, FixRecord>();
  private readonly files = new Map<string, string>();
  private readonly flows = new Map<string, string>();
  private readonly evals: Array<{ fix: string; score: number; rubric: unknown; verdict: string; model: string; createdAt: number }> = [];
  private readonly transitions: TransitionRow[] = [];
  private edges: EdgeRow[] = [];
  private readonly listeners = new Set<(change: ChangeEvent) => void>();

  constructor() {
    this.onChange = async (fn) => {
      this.listeners.add(fn);
      return () => {
        this.listeners.delete(fn);
      };
    };
  }

  async init(): Promise<void> {
    // Nothing to define: the maps are the schema.
  }

  async recordBug(input: Omit<BugRecord, 'id' | 'createdAt'> & { embedding: number[] }): Promise<BugRecord> {
    assertEmbedding(input.embedding, 'recordBug');
    const createdAt = Date.now();
    const incidentId = bareKey('incident', input.incidentId);
    const flowId = input.flowId ? bareKey('flow', input.flowId) : undefined;
    const id = refString('bug', newKey());
    const incidentRef = refString('incident', incidentId);

    if (!this.incidents.has(incidentId)) {
      this.incidents.set(incidentId, {
        id: incidentId,
        title: input.signature,
        status: 'open',
        source: 'manual',
        severity: input.severity,
        openedAt: createdAt,
      });
      this.emit('incident', 'CREATE', incidentRef);
    }

    const row: BugRow = compact<BugRow>({
      id,
      incidentId,
      signature: input.signature,
      flowId,
      errorMessage: input.errorMessage,
      stack: input.stack,
      severity: input.severity,
      createdAt,
      embedding: [...input.embedding],
    });
    this.bugs.set(id, row);
    this.edges.push({ type: 'about', from: incidentRef, to: id });
    if (flowId) {
      const flowRef = refString('flow', flowId);
      if (!this.flows.has(flowRef)) this.flows.set(flowRef, flowId);
      this.edges.push({ type: 'detected_in', from: id, to: flowRef });
    }
    this.emit('bug', 'CREATE', id);
    return toBugRecord(row);
  }

  async similarBugs(
    embedding: number[],
    opts: { limit?: number; minSimilarity?: number; excludeBugId?: string } = {},
  ): Promise<SimilarBug[]> {
    assertEmbedding(embedding, 'similarBugs');
    const limit = clampInt(opts.limit, 1, 50, 5);
    const minSimilarity = opts.minSimilarity ?? 0;
    const exclude = opts.excludeBugId ? refString('bug', bareKey('bug', opts.excludeBugId)) : undefined;

    const scored = [...this.bugs.values()]
      .filter((bug) => bug.id !== exclude)
      .map((bug) => ({ bug, raw: cosine(embedding, bug.embedding) }))
      .sort((a, b) => b.raw - a.raw || b.bug.createdAt - a.bug.createdAt);

    const out: SimilarBug[] = [];
    for (const { bug, raw } of scored) {
      const similarity = clamp01(raw);
      if (similarity < minSimilarity) continue;
      out.push({ bug: toBugRecord(bug), similarity, fixes: this.fixesOf(bug.id) });
      if (out.length >= limit) break;
    }
    return out;
  }

  async linkSimilar(bugId: string, otherBugId: string, similarity: number): Promise<void> {
    const from = refString('bug', bareKey('bug', bugId));
    const to = refString('bug', bareKey('bug', otherBugId));
    if (from === to) return;
    if (!this.bugs.has(from)) throw new Error(`unknown bug: ${bugId}`);
    if (!this.bugs.has(to)) throw new Error(`unknown bug: ${otherBugId}`);
    this.edges = this.edges.filter((e) => !(e.type === 'similar_to' && e.from === from && e.to === to));
    this.edges.push({ type: 'similar_to', from, to, score: clamp01(similarity) });
  }

  async recordFix(input: Omit<FixRecord, 'id' | 'createdAt'>): Promise<FixRecord> {
    const bugRef = refString('bug', bareKey('bug', input.bugId));
    if (!this.bugs.has(bugRef)) throw new Error(`unknown bug: ${input.bugId}`);
    const id = refString('fix', newKey());
    const files = uniquePaths(input.files);
    const fix: FixRecord = compact<FixRecord>({
      id,
      bugId: bugRef,
      incidentId: bareKey('incident', input.incidentId),
      summary: input.summary,
      rootCause: input.rootCause,
      diff: input.diff,
      files,
      verified: input.verified,
      deployed: input.deployed,
      score: input.score,
      createdAt: Date.now(),
    });
    this.fixes.set(id, fix);
    this.edges.push({ type: 'fixed_by', from: bugRef, to: id });
    for (const filePath of files) {
      const fileRef = refString('file', fileKey(filePath));
      if (!this.files.has(fileRef)) this.files.set(fileRef, filePath);
      this.edges.push({ type: 'touches', from: id, to: fileRef });
    }
    this.emit('fix', 'CREATE', id);
    return copyFix(fix);
  }

  async updateFix(id: string, patch: Partial<Pick<FixRecord, 'verified' | 'deployed' | 'score'>>): Promise<void> {
    const ref = refString('fix', bareKey('fix', id));
    const fix = this.fixes.get(ref);
    if (!fix) throw new Error(`unknown fix: ${id}`);
    Object.assign(fix, compact({ verified: patch.verified, deployed: patch.deployed, score: patch.score }));
    this.emit('fix', 'UPDATE', ref);
  }

  async upsertIncident(inc: IncidentSummary): Promise<void> {
    const key = bareKey('incident', inc.id);
    const ref = refString('incident', key);
    const existing = this.incidents.get(key);
    this.incidents.set(key, { ...existing, ...incidentFields(inc), id: key } as IncidentSummary);
    this.emit('incident', existing ? 'UPDATE' : 'CREATE', ref);
  }

  async recordTransition(
    incidentId: string,
    stage: Stage,
    status: 'started' | 'completed' | 'failed',
    data?: Record<string, unknown>,
  ): Promise<void> {
    this.transitions.push({
      incidentId: bareKey('incident', incidentId),
      stage,
      status,
      data: sanitize(data ?? {}),
      occurredAt: Date.now(),
    });
  }

  async recordEval(fixId: string, result: EvalResult): Promise<void> {
    const ref = refString('fix', bareKey('fix', fixId));
    const fix = this.fixes.get(ref);
    if (!fix) throw new Error(`unknown fix: ${fixId}`);
    this.evals.push({
      fix: ref,
      score: result.score,
      rubric: sanitize(result.rubric),
      verdict: result.verdict,
      model: result.model,
      createdAt: Date.now(),
    });
    fix.score = result.score;
    this.emit('fix', 'UPDATE', ref);
  }

  async listIncidents(limit = 50): Promise<IncidentSummary[]> {
    return [...this.incidents.values()]
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, clampInt(limit, 1, 1000, 50))
      .map((inc) => ({ ...inc }));
  }

  async graph(): Promise<MemoryGraph> {
    const bugs = [...this.bugs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, GRAPH_CAPS.bug);
    const fixes = [...this.fixes.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, GRAPH_CAPS.fix);
    const files = [...this.files.entries()].sort((a, b) => a[1].localeCompare(b[1])).slice(0, GRAPH_CAPS.file);
    const flows = [...this.flows.entries()].sort((a, b) => a[1].localeCompare(b[1])).slice(0, GRAPH_CAPS.flow);
    const incidents = [...this.incidents.values()]
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, GRAPH_CAPS.incident);

    const nodes: GraphNode[] = [
      ...bugs.map((bug): GraphNode => ({
        id: bug.id,
        type: 'bug',
        label: shorten(bug.signature ?? bug.id),
        data: compact({ incidentId: bug.incidentId, flowId: bug.flowId, severity: bug.severity, createdAt: bug.createdAt }),
      })),
      ...fixes.map((fix): GraphNode => ({
        id: fix.id,
        type: 'fix',
        label: shorten(fix.summary ?? fix.id),
        data: compact({ bugId: fix.bugId, verified: fix.verified, deployed: fix.deployed, score: fix.score }),
      })),
      ...files.map(([ref, filePath]): GraphNode => ({ id: ref, type: 'file', label: filePath, data: { path: filePath } })),
      ...flows.map(([ref, name]): GraphNode => ({ id: ref, type: 'flow', label: name, data: { name } })),
      ...incidents.map((inc): GraphNode => ({
        id: refString('incident', inc.id),
        type: 'incident',
        label: shorten(inc.title ?? inc.id),
        data: compact({ status: inc.status, outcome: inc.outcome, severity: inc.severity, openedAt: inc.openedAt }),
      })),
    ];

    const edges: GraphEdge[] = EDGE_TYPES.flatMap((type) =>
      this.edges
        .filter((e) => e.type === type)
        .map((e): GraphEdge =>
          compact<GraphEdge>({
            from: e.from,
            to: e.to,
            type,
            weight: type === 'similar_to' ? e.score : undefined,
          }),
        ),
    );
    return buildGraph(nodes, edges);
  }

  async stats(): Promise<MemoryStats> {
    return summarizeIncidents([...this.incidents.values()], this.bugs.size, this.fixes.size);
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }

  private fixesOf(bugRef: string): FixRecord[] {
    return this.edges
      .filter((e) => e.type === 'fixed_by' && e.from === bugRef)
      .flatMap((e) => {
        const fix = this.fixes.get(e.to);
        return fix ? [fix] : [];
      })
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(copyFix);
  }

  private emit(table: ChangeEvent['table'], action: ChangeEvent['action'], id: string): void {
    for (const fn of this.listeners) {
      try {
        fn({ table, action, id });
      } catch (err) {
        log.warn(`onChange listener failed: ${errorMessage(err)}`);
      }
    }
  }
}

function toBugRecord(row: BugRow): BugRecord {
  return compact<BugRecord>({
    id: row.id,
    incidentId: row.incidentId,
    signature: row.signature,
    flowId: row.flowId,
    errorMessage: row.errorMessage,
    stack: row.stack,
    severity: row.severity,
    createdAt: row.createdAt,
  });
}

function copyFix(fix: FixRecord): FixRecord {
  return { ...fix, files: [...fix.files] };
}
