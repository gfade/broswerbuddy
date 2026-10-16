/**
 * HealOps shared contracts. Every package codes against these interfaces;
 * sponsor adapters implement them, the agent consumes them.
 */
import type { Page } from 'playwright-core';

// ───────────────────────────── core vocabulary ─────────────────────────────

export type Sponsor = 'anchor' | 'surreal' | 'daytona' | 'bedrock' | 'aws' | 'arize';

export type Stage =
  | 'detect' | 'triage' | 'recall' | 'reproduce' | 'patch'
  | 'verify' | 'gate' | 'deploy' | 'judge' | 'learn';

export const STAGES: Stage[] = [
  'detect', 'triage', 'recall', 'reproduce', 'patch', 'verify', 'gate', 'deploy', 'judge', 'learn',
];

/** Which sponsor powers each stage (drives colours + labels in the UI). */
export const STAGE_SPONSOR: Record<Stage, Sponsor> = {
  detect: 'anchor',
  triage: 'bedrock',
  recall: 'surreal',
  reproduce: 'daytona',
  patch: 'bedrock',
  verify: 'daytona',
  gate: 'arize',
  deploy: 'aws',
  judge: 'arize',
  learn: 'surreal',
};

export type Severity = 'sev1' | 'sev2' | 'sev3';
export type IncidentSource = 'patrol' | 'flag' | 'manual';
export type IncidentStatus =
  | 'open' | 'healing' | 'awaiting_approval' | 'healed' | 'rolled_back'
  | 'escalated' | 'quarantined' | 'not_reproducible' | 'rejected' | 'failed';
export type IncidentOutcome =
  | 'healed' | 'rolled_back' | 'escalated' | 'quarantined' | 'not_reproducible' | 'rejected' | 'failed';
export type Autonomy = 'observe' | 'suggest' | 'auto_low' | 'full';

/** A file of the target app. `path` is relative to the site root and uses forward slashes. */
export interface SourceFile {
  path: string;
  content: string;
}

/** An exact find/replace edit. `find` must occur exactly once in the file. */
export interface CodeEdit {
  path: string;
  find: string;
  replace: string;
}

// ───────────────────────────── flows (Anchor / local browser) ─────────────────────────────

export interface FlowContext {
  page: Page;
  /** Base URL of the site under test, no trailing slash. */
  baseUrl: string;
  /** Run one named step; failures are recorded against that step and rethrown. */
  step(name: string, fn: () => Promise<void>): Promise<void>;
}

export interface FlowDefinition {
  id: string;
  name: string;
  description: string;
  /** Critical flows are patrolled on every tick. */
  critical: boolean;
  run(ctx: FlowContext): Promise<void>;
}

export interface FlowStepResult {
  index: number;
  name: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface FlowRunResult {
  flowId: string;
  ok: boolean;
  baseUrl: string;
  provider: 'anchor' | 'local';
  steps: FlowStepResult[];
  /** index of the failed step, if any */
  failedStep?: number;
  error?: { message: string; stack?: string };
  /** console.error messages captured from the page */
  consoleErrors: string[];
  /** uncaught page errors (window.onerror / unhandled rejections) with stacks */
  pageErrors: string[];
  /** absolute path to a PNG screenshot taken at the end (or at failure) */
  screenshotFile?: string;
  sessionId?: string;
  liveViewUrl?: string;
  recordingUrl?: string;
  startedAt: number;
  durationMs: number;
}

export interface RunFlowOptions {
  baseUrl: string;
  /** directory where screenshots etc. may be written */
  artifactsDir: string;
  onStep?: (step: FlowStepResult) => void;
  onSession?: (info: { provider: 'anchor' | 'local'; sessionId?: string; liveViewUrl?: string }) => void;
  /** force the local browser even if Anchor is configured */
  forceLocal?: boolean;
  /** overall timeout for the flow, default 45s */
  timeoutMs?: number;
}

export interface BrowserRunner {
  /** the primary provider; individual runs may still fall back to local (see FlowRunResult.provider) */
  readonly provider: 'anchor' | 'local';
  runFlow(flow: FlowDefinition, opts: RunFlowOptions): Promise<FlowRunResult>;
  close(): Promise<void>;
}

// ───────────────────────────── sandboxes (Daytona / local) ─────────────────────────────

export interface ExecResult {
  exitCode: number;
  output: string;
  durationMs: number;
}

export interface ExecOptions {
  /** relative to the sandbox workdir */
  cwd?: string;
  timeoutSec?: number;
  env?: Record<string, string>;
  /** called for each output line as it arrives (best effort; may be called once at the end) */
  onLine?: (line: string) => void;
}

export interface Sandbox {
  readonly id: string;
  readonly provider: 'daytona' | 'local';
  /** absolute workspace root inside the sandbox */
  readonly workdir: string;
  /** Write files under workdir (optionally under `subdir`), creating directories as needed. */
  writeFiles(files: SourceFile[], subdir?: string): Promise<void>;
  /** Read a file relative to workdir. */
  readFile(path: string): Promise<string>;
  /** Run a shell command (bash on Daytona, the platform shell locally) in workdir. */
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Serve `subdir` over HTTP. Returns a URL the browser runner can open (public for Daytona). */
  serveStatic(subdir: string, port: number): Promise<{ url: string; public: boolean }>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  readonly provider: 'daytona' | 'local';
  create(opts: { label: string; incidentId?: string }): Promise<Sandbox>;
}

// ───────────────────────────── memory (SurrealDB) ─────────────────────────────

export interface BugRecord {
  id: string;
  incidentId: string;
  /** short normalised error signature, e.g. "TypeError: Cannot read properties of undefined (reading 'subtotal') @ js/cart.js" */
  signature: string;
  flowId?: string;
  errorMessage: string;
  stack?: string;
  severity: Severity;
  createdAt: number;
}

export interface FixRecord {
  id: string;
  bugId: string;
  incidentId: string;
  summary: string;
  rootCause: string;
  /** unified diff */
  diff: string;
  files: string[];
  verified: boolean;
  deployed: boolean;
  score?: number;
  createdAt: number;
}

export interface SimilarBug {
  bug: BugRecord;
  /** cosine similarity 0..1 */
  similarity: number;
  fixes: FixRecord[];
}

export interface GraphNode {
  id: string;
  type: 'bug' | 'fix' | 'file' | 'flow' | 'incident';
  label: string;
  data?: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: 'similar_to' | 'fixed_by' | 'touches' | 'detected_in' | 'about';
  weight?: number;
}

export interface MemoryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface MemoryStats {
  incidents: number;
  healed: number;
  bugs: number;
  fixes: number;
  /** incidents where recall found a similar past bug with a fix */
  memoryHits: number;
  rollbacks: number;
  avgHealMs?: number;
  avgScore?: number;
}

export interface IncidentSummary {
  id: string;
  title: string;
  status: IncidentStatus;
  source: IncidentSource;
  flowId?: string;
  severity: Severity;
  openedAt: number;
  closedAt?: number;
  outcome?: IncidentOutcome;
  /** Arize judge score 0..100 */
  score?: number;
  /** id of the past bug recall matched, if any */
  memoryHit?: string;
  healMs?: number;
  bugId?: string;
  fixId?: string;
  traceId?: string;
  traceUrl?: string;
  error?: string;
}

export interface Memory {
  readonly provider: 'surrealdb-cloud' | 'surrealdb-embedded' | 'in-memory';
  init(): Promise<void>;
  recordBug(input: Omit<BugRecord, 'id' | 'createdAt'> & { embedding: number[] }): Promise<BugRecord>;
  similarBugs(
    embedding: number[],
    opts?: { limit?: number; minSimilarity?: number; excludeBugId?: string },
  ): Promise<SimilarBug[]>;
  linkSimilar(bugId: string, otherBugId: string, similarity: number): Promise<void>;
  recordFix(input: Omit<FixRecord, 'id' | 'createdAt'>): Promise<FixRecord>;
  updateFix(id: string, patch: Partial<Pick<FixRecord, 'verified' | 'deployed' | 'score'>>): Promise<void>;
  upsertIncident(inc: IncidentSummary): Promise<void>;
  recordTransition(
    incidentId: string,
    stage: Stage,
    status: 'started' | 'completed' | 'failed',
    data?: Record<string, unknown>,
  ): Promise<void>;
  recordEval(fixId: string, result: EvalResult): Promise<void>;
  listIncidents(limit?: number): Promise<IncidentSummary[]>;
  graph(): Promise<MemoryGraph>;
  stats(): Promise<MemoryStats>;
  /** Optional realtime feed (SurrealDB LIVE SELECT). Returns an unsubscribe function. */
  onChange?(fn: (change: { table: string; action: 'CREATE' | 'UPDATE' | 'DELETE'; id: string }) => void): Promise<() => void>;
  close(): Promise<void>;
}

// ───────────────────────────── LLM (Claude via Bedrock / Anthropic API) ─────────────────────────────

export type LLMProvider = 'bedrock' | 'anthropic' | 'offline';

/** Embedding vectors are always EMBED_DIM long and L2-normalised. */
export const EMBED_DIM = 256;

export interface PatchInput {
  incidentId: string;
  title: string;
  flowName?: string;
  error: { message: string; stack?: string };
  failedStep?: string;
  consoleErrors: string[];
  /** the full current source of the app (small static site) */
  files: SourceFile[];
  /** output of the failing repro run (tests and/or flow) */
  reproOutput?: string;
  similarFixes: { summary: string; rootCause: string; diff: string; similarity: number }[];
  previousAttempts: { summary: string; failure: string }[];
  /** free-text bug report from the flag widget, already screened */
  userReport?: string;
  /** canned fix used only when the LLM provider is 'offline' */
  offlineHint?: { summary: string; rootCause: string; edits: CodeEdit[] };
}

export interface PatchProposal {
  summary: string;
  rootCause: string;
  /** 2-5 short reasoning bullets shown in the UI */
  reasoning: string[];
  /** 0..1 */
  confidence: number;
  edits: CodeEdit[];
  /** optional node:test regression test (path relative to the sandbox workdir, e.g. "tests/regression-xyz.test.mjs") */
  regressionTest?: SourceFile;
  model: string;
  provider: LLMProvider;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface TriageInput {
  title: string;
  error: string;
  source: IncidentSource;
  userReport?: string;
  flowName?: string;
}

export interface TriageResult {
  severity: Severity;
  category: string;
  isBug: boolean;
  summary: string;
  model: string;
}

export interface ScreenResult {
  safe: boolean;
  reason?: string;
  provider: 'bedrock-guardrails' | 'claude-classifier' | 'heuristic';
}

export interface JudgeInput {
  title: string;
  error: string;
  rootCause: string;
  diff: string;
  reproOutput?: string;
  verifyOutput?: string;
  usedMemory: boolean;
  deployOutcome?: string;
}

export interface EvalRubric {
  correctness: number;
  minimality: number;
  testCoverage: number;
  safety: number;
  memoryUse: number;
}

export interface EvalResult {
  /** 0..100 */
  score: number;
  /** each 0..1 */
  rubric: EvalRubric;
  verdict: string;
  model: string;
}

export interface LLMStreamHandlers {
  onThinking?: (delta: string) => void;
  onText?: (delta: string) => void;
}

export interface LLM {
  readonly provider: LLMProvider;
  readonly models: { patch: string; judge: string; triage: string; embed: string };
  readonly guardrails: ScreenResult['provider'];
  embed(text: string): Promise<number[]>;
  screen(text: string, kind: 'flag' | 'page' | 'output'): Promise<ScreenResult>;
  triage(input: TriageInput): Promise<TriageResult>;
  proposePatch(input: PatchInput, handlers?: LLMStreamHandlers): Promise<PatchProposal>;
  judge(input: JudgeInput): Promise<EvalResult>;
}

// ───────────────────────────── telemetry (Arize / OpenTelemetry) ─────────────────────────────

export type Attr = string | number | boolean;
export type SpanKind = 'AGENT' | 'CHAIN' | 'LLM' | 'TOOL' | 'RETRIEVER' | 'EMBEDDING' | 'EVALUATOR' | 'GUARDRAIL';

export interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  setAttributes(attrs: Record<string, Attr | undefined>): void;
  addEvent(name: string, attrs?: Record<string, Attr>): void;
  /** mark the span as errored (does not end it) */
  fail(err: unknown): void;
  end(): void;
}

export interface RecordedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startMs: number;
  endMs?: number;
  status: 'ok' | 'error' | 'unset';
  attributes: Record<string, Attr>;
}

export interface Telemetry {
  readonly provider: 'arize' | 'local';
  startSpan(
    name: string,
    opts?: { parent?: SpanHandle; kind?: SpanKind; attributes?: Record<string, Attr | undefined> },
  ): SpanHandle;
  /** deep link to the trace in the Arize UI when known */
  traceUrl(traceId: string): string | undefined;
  /** spans recorded in-process for a trace (for the dashboard waterfall) */
  spans(traceId: string): RecordedSpan[];
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

// ───────────────────────────── deploy (AWS S3 / local host) ─────────────────────────────

export interface Deployer {
  readonly provider: 'aws-s3' | 'local';
  /** Make sure the store is hosted; publishes `files` as `version` if nothing is live yet. */
  bootstrap(files: SourceFile[], version: string): Promise<void>;
  /** Base URL that patrols should open (public when available), no trailing slash. */
  liveUrl(): string;
  currentVersion(): Promise<string>;
  /** Source files of the currently live version. */
  liveFiles(): Promise<SourceFile[]>;
  /** Upload `files` as `version` without making it live. Returns a URL serving that version. */
  stageCanary(version: string, files: SourceFile[]): Promise<{ canaryUrl: string }>;
  /** Make a staged version live. */
  promote(version: string): Promise<void>;
  /** Restore the previously live version. */
  rollback(): Promise<{ restoredVersion: string }>;
  /** Force-publish files as live immediately (used by the "break it again" demo reseed). */
  publish(files: SourceFile[], version: string, note?: string): Promise<void>;
  history(): Promise<{ version: string; at: number; note?: string }[]>;
  close(): Promise<void>;
}

// ───────────────────────────── demo store seeds ─────────────────────────────

export interface BugSeed {
  id: string;
  title: string;
  /** flow that should fail while this bug is live */
  flowId: string;
  description: string;
  /** files (relative to the site root) to overwrite to inject the bug */
  buggyFiles: SourceFile[];
  /** reference fix, used only when the LLM provider is 'offline' */
  offlineFix: { summary: string; rootCause: string; edits: CodeEdit[] };
}

// ───────────────────────────── runtime contract (agent ⇄ server) ─────────────────────────────

export interface ProviderModes {
  browser: BrowserRunner['provider'];
  sandbox: SandboxProvider['provider'];
  memory: Memory['provider'];
  llm: LLMProvider;
  guardrails: ScreenResult['provider'];
  telemetry: Telemetry['provider'];
  deploy: Deployer['provider'];
  models: LLM['models'];
}

export interface FlowInfo {
  id: string;
  name: string;
  description: string;
  critical: boolean;
  lastRun?: { ok: boolean; at: number; durationMs: number; provider: 'anchor' | 'local' };
  /** last 20 results, oldest first */
  history: boolean[];
}

export interface FlagInput {
  note: string;
  url: string;
  events?: { type: string; target?: string; at: number; detail?: string }[];
  consoleErrors?: string[];
  viewport?: [number, number];
  userAgent?: string;
}

export interface DashboardStats extends MemoryStats {
  liveVersion: string;
  patrolling: boolean;
  patrolIntervalSec: number;
}

export interface HealOpsRuntime {
  readonly modes: ProviderModes;
  readonly bus: import('./events.js').EventBus;
  init(): Promise<void>;
  liveUrl(): string;
  listFlows(): FlowInfo[];
  /** Run one flow now; opens (and heals) an incident if it fails and no incident is active for it. */
  runFlow(flowId: string, trigger?: 'patrol' | 'manual'): Promise<{ result: FlowRunResult; incidentId?: string }>;
  submitFlag(input: FlagInput): Promise<{ flagId: string; quarantined: boolean; incidentId?: string; reason?: string }>;
  listIncidents(): Promise<IncidentSummary[]>;
  getIncident(id: string): Promise<IncidentDetail | undefined>;
  approve(incidentId: string, approved: boolean): Promise<void>;
  takeover(incidentId: string): Promise<void>;
  rollback(): Promise<{ restoredVersion: string }>;
  /** Demo: re-inject a seeded bug ("break it again"). */
  reseed(seedId: string): Promise<{ version: string }>;
  seeds(): { id: string; title: string; flowId: string; description: string }[];
  memoryGraph(): Promise<MemoryGraph>;
  stats(): Promise<DashboardStats>;
  startPatrol(intervalSec?: number): void;
  stopPatrol(): void;
  shutdown(): Promise<void>;
}

export interface IncidentDetail extends IncidentSummary {
  events: import('./events.js').IncidentEvent[];
  spans: RecordedSpan[];
  patch?: { summary: string; rootCause: string; diff: string; confidence: number; model: string };
  eval?: EvalResult;
  screenshotUrl?: string;
}
