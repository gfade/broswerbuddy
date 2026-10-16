import {
  createLogger, errorMessage, truncate,
  type Attr, type ApplyEditsResult, type EvalResult, type EventBus, type FlowDefinition, type FlowRunResult,
  type IncidentDetail, type IncidentEvent, type IncidentOutcome, type IncidentSource, type IncidentStatus,
  type IncidentSummary, type PatchProposal, type Sandbox, type Severity, type SimilarBug, type SourceFile,
  type SpanHandle, type Stage,
} from '@healops/shared';
import type { RuntimeDeps } from './deps.js';

export const log = createLogger('agent');

/** Distributive Omit so each union member keeps its own fields (used for event inputs). */
export type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventInput = DistOmit<IncidentEvent, 'at'>;

export type FlowPurpose = 'patrol' | 'manual' | 'reproduce' | 'verify' | 'smoke';

export const ACTIVE_STATUSES: IncidentStatus[] = ['open', 'healing', 'awaiting_approval'];

/** Thrown inside the pipeline to end it with a specific outcome. */
export class Closed extends Error {
  constructor(readonly outcome: IncidentOutcome, message: string) {
    super(message);
    this.name = 'Closed';
  }
}

export interface Approval {
  settle(approved: boolean): void;
}

export interface IncidentRecord {
  id: string;
  title: string;
  source: IncidentSource;
  flowId?: string;
  error: string;
  severity: Severity;
  status: IncidentStatus;
  openedAt: number;
  closedAt?: number;
  outcome?: IncidentOutcome;
  score?: number;
  memoryHit?: string;
  healMs?: number;
  bugId?: string;
  fixId?: string;
  traceId?: string;
  traceUrl?: string;
  userReport?: string;
  patch?: NonNullable<IncidentDetail['patch']>;
  eval?: EvalResult;
  screenshotUrl?: string;
  /** set by takeover(): the pipeline stops at its next checkpoint */
  abort: boolean;
  /** present while the gate waits for approve() */
  approval?: Approval;
}

/** Services shared by every incident: the event bus, persistence and flow execution. */
export interface Hub {
  readonly deps: RuntimeDeps;
  readonly bus: EventBus;
  emit(event: EventInput): void;
  persist(rec: IncidentRecord): Promise<void>;
  runFlow(flow: FlowDefinition, purpose: FlowPurpose, incidentId: string | undefined, baseUrl: string): Promise<FlowRunResult>;
}

/** Per-heal working state, passed through the stage functions. */
export interface Heal {
  readonly hub: Hub;
  readonly rec: IncidentRecord;
  readonly failing: FlowRunResult;
  flow?: FlowDefinition;
  rootSpan?: SpanHandle;
  started: Set<Stage>;
  sandbox?: Sandbox;
  previewUrl?: string;
  liveFiles: SourceFile[];
  similar: SimilarBug[];
  similarFixes: { summary: string; rootCause: string; diff: string; similarity: number }[];
  reproOutput: string;
  attempts: number;
  previousAttempts: { summary: string; failure: string }[];
  /** similarity edges written to memory (for memory.learned) */
  links: number;
  proposal?: PatchProposal;
  applied?: ApplyEditsResult;
  verifyOutput?: string;
  deployOutcome: 'promoted' | 'rolled_back';
}

/** Run an adapter call; log and swallow failures (used for memory and telemetry, which never block a heal). */
export async function soft<T>(what: string, fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    log.warn(`${what} failed: ${errorMessage(err)}`);
    return undefined;
  }
}

export function softSync<T>(what: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    log.warn(`${what} failed: ${errorMessage(err)}`);
    return undefined;
  }
}

export function toSummary(rec: IncidentRecord): IncidentSummary {
  return {
    id: rec.id,
    title: rec.title,
    status: rec.status,
    source: rec.source,
    flowId: rec.flowId,
    severity: rec.severity,
    openedAt: rec.openedAt,
    closedAt: rec.closedAt,
    outcome: rec.outcome,
    score: rec.score,
    memoryHit: rec.memoryHit,
    healMs: rec.healMs,
    bugId: rec.bugId,
    fixId: rec.fixId,
    traceId: rec.traceId,
    traceUrl: rec.traceUrl,
    error: rec.error,
  };
}

/** Mark an incident closed: emits incident.closed and persists. Idempotent. */
export async function closeRecord(hub: Hub, rec: IncidentRecord, outcome: IncidentOutcome, summary: string): Promise<void> {
  if (rec.closedAt !== undefined) return;
  rec.outcome = outcome;
  rec.status = outcome;
  rec.approval = undefined;
  rec.closedAt = Date.now();
  rec.healMs = rec.closedAt - rec.openedAt;
  hub.emit({ type: 'incident.closed', incidentId: rec.id, outcome, durationMs: rec.healMs, score: rec.score, summary });
  await hub.persist(rec);
}

/** Span attributes for a call to an LLM. Prompt/completion are truncated to 8KB. */
export function llmAttrs(
  model: string,
  provider: string,
  input?: unknown,
  output?: unknown,
  usage?: { inputTokens: number; outputTokens: number },
): Record<string, Attr | undefined> {
  const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  return {
    'llm.model_name': model,
    'llm.provider': provider,
    'llm.token_count.prompt': usage?.inputTokens,
    'llm.token_count.completion': usage?.outputTokens,
    'input.value': input === undefined ? undefined : truncate(text(input) ?? '', 8192),
    'output.value': output === undefined ? undefined : truncate(text(output) ?? '', 8192),
  };
}
