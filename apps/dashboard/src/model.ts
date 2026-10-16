// Event-derived view model. applyEvent() folds the IncidentEvent stream into a plain mutable model.
// The UI renders purely from this model plus REST snapshots (state.ts), so live and replayed data
// go through exactly the same code path.
import type { EvalRubric, FlowStepResult, IncidentEvent, IncidentOutcome, IncidentSource, IncidentStatus, Severity, Stage } from '@healops/shared/types';
import { STAGES } from './constants';

export type StageState = 'pending' | 'started' | 'completed' | 'failed' | 'skipped';
export type Purpose = 'patrol' | 'manual' | 'reproduce' | 'verify' | 'smoke';

export interface RunView {
  key: string;
  flowId: string;
  incidentId?: string;
  purpose: Purpose;
  baseUrl?: string;
  startedAt: number;
  endedAt?: number;
  provider?: 'anchor' | 'local';
  sessionId?: string;
  liveViewUrl?: string;
  steps: FlowStepResult[];
  ok?: boolean;
  durationMs?: number;
  failedStep?: number;
  error?: string;
  screenshotUrl?: string;
}

export interface StageView {
  status: StageState;
  startedAt?: number;
  endedAt?: number;
  detail?: string;
}

export interface MatchView {
  bugId: string;
  similarity: number;
  signature: string;
  fixSummary?: string;
  score?: number;
}

export interface PatchView {
  attempt: number;
  summary: string;
  rootCause: string;
  reasoning: string[];
  confidence: number;
  diff: string;
  files: string[];
  model: string;
  provider: string;
  at: number;
}

export interface DeployView {
  phase: 'canary' | 'smoke' | 'promoted' | 'rolled_back' | 'failed';
  version: string;
  ok: boolean;
  url?: string;
  detail?: string;
  provider: string;
  at: number;
}

export interface EvalView {
  score: number;
  rubric: EvalRubric;
  verdict: string;
  model: string;
  traceUrl?: string;
  at: number;
}

export interface GateView {
  risk: number;
  decision: 'auto' | 'needs_approval' | 'blocked';
  reasons: string[];
  preScore?: number;
  at: number;
  resolved?: boolean;
  approved?: boolean;
}

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

export interface IncidentView {
  id: string;
  title: string;
  severity: Severity;
  source: IncidentSource;
  flowId?: string;
  error: string;
  openedAt: number;
  closedAt?: number;
  status: IncidentStatus;
  outcome?: IncidentOutcome;
  durationMs?: number;
  score?: number;
  summary?: string;
  traceId?: string;
  traceUrl?: string;
  stages: Record<Stage, StageView>;
  currentStage?: Stage;
  runs: RunView[];
  triage?: { safe: boolean; guard: string; severity: Severity; category: string; summary: string; reason?: string };
  matches?: { bugId: string; matches: MatchView[]; at: number };
  sandbox?: { id: string; provider: 'daytona' | 'local'; at: number };
  sandboxLogs: { phase: 'reproduce' | 'verify'; line: string }[];
  results: { phase: 'reproduce' | 'verify'; passed: boolean; summary: string; durationMs: number; previewUrl?: string; at: number }[];
  llm: { kind: 'thinking' | 'text'; text: string }[];
  llmModel?: string;
  patches: PatchView[];
  rejections: { attempt: number; reason: string }[];
  gate?: GateView;
  versionBefore?: string;
  deploys: DeployView[];
  evalResult?: EvalView;
  learned?: { bugId: string; fixId: string; edges: number; at: number };
  logs: LogLine[];
}

export interface Model {
  incidents: Map<string, IncidentView>;
  /** incident ids, oldest first */
  order: string[];
  /** runs that are not tied to an incident (patrol ticks), newest last */
  runs: RunView[];
  logs: LogLine[];
  liveVersion?: string;
  storeUrl?: string;
  tick?: { at: number; nextInSec: number; flows: { flowId: string; ok: boolean }[] };
}

export const model: Model = { incidents: new Map(), order: [], runs: [], logs: [] };

export function resetModel(): void {
  model.incidents.clear();
  model.order = [];
  model.runs = [];
  model.logs = [];
  model.liveVersion = undefined;
  model.storeUrl = undefined;
  model.tick = undefined;
}

function trim<T>(list: T[], max: number): void {
  if (list.length > max) list.splice(0, list.length - max);
}

function blankStages(): Record<Stage, StageView> {
  const out = {} as Record<Stage, StageView>;
  for (const s of STAGES) out[s] = { status: 'pending' };
  return out;
}

function sortOrder(): void {
  model.order.sort((a, b) => (model.incidents.get(a)?.openedAt ?? 0) - (model.incidents.get(b)?.openedAt ?? 0));
}

export function ensureIncident(id: string, at: number): IncidentView {
  const existing = model.incidents.get(id);
  if (existing) return existing;
  const inc: IncidentView = {
    id,
    title: `Incident #${id}`,
    severity: 'sev2',
    source: 'patrol',
    error: '',
    openedAt: at,
    status: 'open',
    stages: blankStages(),
    runs: [],
    sandboxLogs: [],
    results: [],
    llm: [],
    patches: [],
    rejections: [],
    deploys: [],
    logs: [],
  };
  model.incidents.set(id, inc);
  model.order.push(id);
  sortOrder();
  return inc;
}

function runsOf(incidentId: string | undefined): RunView[] {
  return incidentId ? ensureIncident(incidentId, Date.now()).runs : model.runs;
}

function getOrCreateRun(incidentId: string | undefined, flowId: string, at: number, purpose: Purpose): RunView {
  const list = runsOf(incidentId);
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r.flowId === flowId && r.endedAt === undefined) return r;
  }
  const run: RunView = { key: `${flowId}-${at}-${list.length}`, flowId, incidentId, purpose, startedAt: at, steps: [] };
  list.push(run);
  if (!incidentId) trim(list, 30);
  return run;
}

/** Fold one event into the model. Pure bookkeeping: no rendering, no I/O. */
export function applyEvent(e: IncidentEvent): void {
  switch (e.type) {
    case 'incident.opened': {
      const inc = ensureIncident(e.incidentId, e.at);
      inc.title = e.title;
      inc.source = e.source;
      inc.flowId = e.flowId;
      inc.error = e.error;
      inc.severity = e.severity;
      inc.openedAt = e.at;
      inc.traceId = e.traceId ?? inc.traceId;
      sortOrder();
      break;
    }
    case 'stage.changed': {
      const inc = ensureIncident(e.incidentId, e.at);
      const idx = STAGES.indexOf(e.stage);
      const view = inc.stages[e.stage];
      if (e.status === 'started') {
        view.status = 'started';
        view.startedAt = e.at;
        inc.currentStage = e.stage;
        // an earlier stage that never reported completion is done once a later one starts
        for (let i = 0; i < idx; i++) {
          const prev = inc.stages[STAGES[i]];
          if (prev.status === 'started') {
            prev.status = 'completed';
            prev.endedAt = prev.endedAt ?? e.at;
          }
        }
        if (e.stage !== 'gate' && (inc.status === 'open' || inc.status === 'awaiting_approval')) inc.status = 'healing';
      } else {
        view.status = e.status;
        view.endedAt = e.at;
      }
      if (e.detail) view.detail = e.detail;
      break;
    }
    case 'flow.started': {
      const run = getOrCreateRun(e.incidentId, e.flowId, e.at, e.purpose);
      run.purpose = e.purpose;
      run.baseUrl = e.baseUrl;
      run.startedAt = e.at;
      break;
    }
    case 'anchor.session': {
      const run = getOrCreateRun(e.incidentId, e.flowId, e.at, 'patrol');
      run.provider = e.provider;
      run.sessionId = e.sessionId;
      run.liveViewUrl = e.liveViewUrl;
      break;
    }
    case 'anchor.step': {
      const run = getOrCreateRun(e.incidentId, e.flowId, e.at, 'patrol');
      const i = run.steps.findIndex((s) => s.index === e.step.index);
      if (i >= 0) run.steps[i] = e.step;
      else run.steps.push(e.step);
      break;
    }
    case 'flow.completed': {
      const run = getOrCreateRun(e.incidentId, e.flowId, e.at, e.purpose);
      run.purpose = e.purpose;
      run.endedAt = e.at;
      run.ok = e.ok;
      run.durationMs = e.durationMs;
      run.failedStep = e.failedStep;
      run.error = e.error;
      run.provider = e.provider;
      run.screenshotUrl = e.screenshotUrl ?? run.screenshotUrl;
      break;
    }
    case 'triage.result': {
      const inc = ensureIncident(e.incidentId, e.at);
      inc.triage = { safe: e.safe, guard: e.guard, severity: e.severity, category: e.category, summary: e.summary, reason: e.reason };
      inc.severity = e.severity;
      break;
    }
    case 'memory.match': {
      const inc = ensureIncident(e.incidentId, e.at);
      inc.matches = {
        bugId: e.bugId,
        at: e.at,
        matches: e.matches.map((m) => ({ bugId: m.bugId, similarity: m.similarity, signature: m.signature, fixSummary: m.fixSummary, score: m.score })),
      };
      break;
    }
    case 'sandbox.created': {
      const inc = ensureIncident(e.incidentId, e.at);
      inc.sandbox = { id: e.sandboxId, provider: e.provider, at: e.at };
      break;
    }
    case 'sandbox.log': {
      const inc = ensureIncident(e.incidentId, e.at);
      const phase = inc.stages.verify.startedAt !== undefined ? 'verify' : 'reproduce';
      inc.sandboxLogs.push({ phase, line: e.line });
      trim(inc.sandboxLogs, 400);
      break;
    }
    case 'sandbox.result': {
      const inc = ensureIncident(e.incidentId, e.at);
      inc.results.push({ phase: e.phase, passed: e.passed, summary: e.summary, durationMs: e.durationMs, previewUrl: e.previewUrl, at: e.at });
      break;
    }
    case 'llm.delta': {
      // never trimmed: the reasoning view appends by index
      const inc = ensureIncident(e.incidentId, e.at);
      inc.llm.push({ kind: e.kind, text: e.text });
      inc.llmModel = e.model;
      break;
    }
    case 'patch.ready': {
      const inc = ensureIncident(e.incidentId, e.at);
      inc.patches.push({
        attempt: e.attempt,
        summary: e.summary,
        rootCause: e.rootCause,
        reasoning: e.reasoning,
        confidence: e.confidence,
        diff: e.diff,
        files: e.files,
        model: e.model,
        provider: e.provider,
        at: e.at,
      });
      break;
    }
    case 'patch.rejected': {
      const inc = ensureIncident(e.incidentId, e.at);
      inc.rejections.push({ attempt: e.attempt, reason: e.reason });
      break;
    }
    case 'gate.decision': {
      const inc = ensureIncident(e.incidentId, e.at);
      inc.gate = { risk: e.risk, decision: e.decision, reasons: e.reasons, preScore: e.preScore, at: e.at };
      if (e.decision === 'needs_approval') inc.status = 'awaiting_approval';
      break;
    }
    case 'approval.resolved': {
      const inc = ensureIncident(e.incidentId, e.at);
      if (inc.gate) {
        inc.gate.resolved = true;
        inc.gate.approved = e.approved;
      }
      if (e.approved && inc.status === 'awaiting_approval') inc.status = 'healing';
      break;
    }
    case 'deploy.progress': {
      const inc = ensureIncident(e.incidentId, e.at);
      if (e.phase === 'canary' && inc.versionBefore === undefined) inc.versionBefore = model.liveVersion;
      inc.deploys.push({ phase: e.phase, version: e.version, ok: e.ok, url: e.url, detail: e.detail, provider: e.provider, at: e.at });
      break;
    }
    case 'eval.scored': {
      const inc = ensureIncident(e.incidentId, e.at);
      inc.evalResult = { score: e.score, rubric: e.rubric, verdict: e.verdict, model: e.model, traceUrl: e.traceUrl, at: e.at };
      inc.score = e.score;
      if (e.traceUrl) inc.traceUrl = e.traceUrl;
      break;
    }
    case 'memory.learned': {
      const inc = ensureIncident(e.incidentId, e.at);
      inc.learned = { bugId: e.bugId, fixId: e.fixId, edges: e.edges, at: e.at };
      break;
    }
    case 'incident.closed': {
      const inc = ensureIncident(e.incidentId, e.at);
      inc.closedAt = e.at;
      inc.outcome = e.outcome;
      inc.status = e.outcome;
      inc.durationMs = e.durationMs;
      if (e.score !== undefined) inc.score = e.score;
      if (e.summary) inc.summary = e.summary;
      if (e.outcome === 'healed') {
        for (const s of STAGES) {
          const v = inc.stages[s];
          if (v.status === 'started') {
            v.status = 'completed';
            v.endedAt = v.endedAt ?? e.at;
          }
        }
      }
      break;
    }
    case 'patrol.tick': {
      model.tick = { at: e.at, nextInSec: e.nextInSec, flows: e.flows };
      break;
    }
    case 'store.version': {
      model.liveVersion = e.version;
      model.storeUrl = e.url;
      break;
    }
    case 'log': {
      const line: LogLine = { level: e.level, message: e.message, at: e.at };
      if (e.incidentId) {
        const inc = ensureIncident(e.incidentId, e.at);
        inc.logs.push(line);
        trim(inc.logs, 200);
      } else {
        model.logs.push(line);
        trim(model.logs, 100);
      }
      break;
    }
    default:
      break;
  }
}

// ---- selectors -------------------------------------------------------------

export function incidentList(): IncidentView[] {
  const out: IncidentView[] = [];
  for (const id of model.order) {
    const inc = model.incidents.get(id);
    if (inc) out.push(inc);
  }
  return out;
}

/** The incident the Live view is about: the newest open one, else the newest one (idle state). */
export function currentIncident(): IncidentView | undefined {
  const list = incidentList();
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].closedAt === undefined) return list[i];
  }
  return list[list.length - 1];
}

export function stageIndex(inc: IncidentView): number {
  return inc.currentStage ? STAGES.indexOf(inc.currentStage) : -1;
}

/** Stage state as shown in the stepper (an earlier unfinished stage counts as completed). */
export function displayStage(inc: IncidentView, i: number): StageState {
  const v = inc.stages[STAGES[i]];
  if (v.status === 'started' && stageIndex(inc) > i) return 'completed';
  return v.status;
}

/** The Anchor run that detected the bug: the failing patrol/manual run if there is one. */
export function pickDetectRun(inc: IncidentView): RunView | undefined {
  const detect = inc.runs.filter((r) => r.purpose === 'patrol' || r.purpose === 'manual');
  const failing = [...detect].reverse().find((r) => r.ok === false);
  return failing ?? detect[detect.length - 1] ?? inc.runs[inc.runs.length - 1];
}

export function lastGlobalRun(): RunView | undefined {
  const withEvidence = [...model.runs].reverse().find((r) => r.steps.length > 0 || r.screenshotUrl);
  return withEvidence ?? model.runs[model.runs.length - 1];
}
