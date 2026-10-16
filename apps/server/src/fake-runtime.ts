// Fake HealOpsRuntime: no sponsors and no network. It plays a scripted but realistic incident lifecycle
// (detect -> ... -> learn) on the same event stream the real runtime uses, so the dashboard can be built against it.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  EventBus, STAGE_SPONSOR, errorMessage, loadConfig, newId, sleep, unifiedDiff,
  type BugRecord, type DashboardStats, type EvalResult, type FixRecord, type FlagInput, type FlowInfo,
  type FlowRunResult, type FlowStepResult, type GraphEdge, type GraphNode, type HealOpsRuntime,
  type IncidentDetail, type IncidentEvent, type IncidentOutcome, type IncidentSource, type IncidentSummary,
  type MemoryGraph, type ProviderModes, type RecordedSpan, type Stage,
} from '@healops/shared';
import { encodePng, screenshotPixels } from './fake-png.js';
import {
  FAKE_FLOWS, FAKE_SEEDS, PAST_BUGS, PAST_FIXES, PAST_INCIDENTS, SCENARIOS,
  type FakeFlow, type FakeScenario,
} from './fake-data.js';

const DAY_MS = 86_400_000;
const INJECTION = /ignore (all |the )?(previous|prior|above) instructions|system prompt|<script/i;

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Git-style diff output: drop the "====" banner and the tab-padded file headers. */
function cleanDiff(raw: string): string {
  const lines = raw
    .split('\n')
    .filter((l) => !l.startsWith('====') && !l.startsWith('Index: '))
    .map((l) => (l.startsWith('--- ') || l.startsWith('+++ ') ? (l.split('\t')[0] ?? l) : l));
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Ends a scripted incident with an outcome (rejected fix, human takeover, shutdown). */
class Stop extends Error {
  constructor(readonly outcome: IncidentOutcome, readonly note: string) {
    super(note);
  }
}

interface StoreVersion {
  version: string;
  at: number;
  note: string;
  /** Seeded bugs that are live in this version. */
  bugs: string[];
}

type Verdict = 'approved' | 'rejected' | 'takeover';

interface Rec {
  summary: IncidentSummary;
  scenario: FakeScenario;
  events: IncidentEvent[];
  spans: RecordedSpan[];
  traceId: string;
  rootSpanId: string;
  stageSpanIds: Partial<Record<Stage, string>>;
  stageStarted: Partial<Record<Stage, number>>;
  currentStage?: Stage;
  sandboxId?: string;
  patch?: IncidentDetail['patch'];
  eval?: EvalResult;
  screenshotUrl?: string;
  similar?: { bugId: string; similarity: number };
  gate?: { resolve(verdict: Verdict): void };
  cancel?: string;
  closed: boolean;
}

interface PlayOpts {
  purpose: 'patrol' | 'manual' | 'verify';
  rec?: Rec;
  failAt?: number;
  error?: { message: string; stack: string };
  countInHistory: boolean;
}

class FakeRuntime implements HealOpsRuntime {
  readonly modes: ProviderModes = {
    browser: 'local',
    sandbox: 'local',
    memory: 'in-memory',
    llm: 'offline',
    guardrails: 'heuristic',
    telemetry: 'local',
    deploy: 'local',
    models: {
      patch: 'claude-opus-5-5',
      judge: 'claude-haiku-5-5',
      triage: 'claude-haiku-5-5',
      embed: 'amazon.titan-embed-text-v2:0',
    },
  };
  readonly bus = new EventBus();

  private readonly cfg = loadConfig();
  private readonly incidents = new Map<string, Rec>();
  private readonly pastSummaries: IncidentSummary[] = [];
  private readonly pastDetails = new Map<string, IncidentDetail>();
  private readonly bugs: BugRecord[] = [];
  private readonly fixes: FixRecord[] = [];
  private readonly similarLinks: GraphEdge[] = [];
  private readonly history = new Map<string, boolean[]>();
  private readonly lastRun = new Map<string, FlowInfo['lastRun']>();
  private store: StoreVersion[] = [];
  private live = 0;
  private rollbacks = 0;
  private patrolSec: number;
  private patrolling = false;
  private patrolTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor() {
    this.patrolSec = this.cfg.patrolIntervalSec;
    const now = Date.now();
    // The demo store boots on 1.4.2 with the cart regression live, so the first checkout run fails.
    this.store = [
      { version: '1.4.1', at: now - 9 * DAY_MS, note: 'release: cart badge refactor', bugs: [] },
      { version: '1.4.2', at: now - 2 * DAY_MS, note: 'release: cart restore refactor', bugs: ['cart-subtotal'] },
    ];
    this.live = 1;
    this.history.set('checkout', [...Array<boolean>(17).fill(true), false, false, false]);
    this.history.set('add-to-cart', Array<boolean>(20).fill(true));
    this.history.set('signup', Array<boolean>(20).fill(true));
    this.lastRun.set('checkout', { ok: false, at: now - 12 * 60_000, durationMs: 4870, provider: 'local' });
    this.lastRun.set('add-to-cart', { ok: true, at: now - 3 * 60_000, durationMs: 2210, provider: 'local' });
    this.lastRun.set('signup', { ok: true, at: now - 7 * 60_000, durationMs: 3560, provider: 'local' });
    this.seedPast(now);
  }

  async init(): Promise<void> {
    const now = Date.now();
    // Replay past incidents into the bus history so a freshly connected dashboard has a timeline.
    const past = [...this.pastDetails.values()].sort((a, b) => a.openedAt - b.openedAt);
    for (const inc of past) {
      for (const event of inc.events) this.bus.emit(event);
    }
    this.bus.emit({ type: 'log', at: now, level: 'info', message: 'fake runtime ready: local browser and sandbox, in-memory memory, no sponsors contacted' });
    this.bus.emit({ type: 'store.version', at: now, version: this.current().version, url: this.liveUrl(), note: this.current().note });
  }

  liveUrl(): string {
    return `http://localhost:${this.cfg.storePort}`;
  }

  listFlows(): FlowInfo[] {
    return FAKE_FLOWS.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      critical: f.critical,
      lastRun: this.lastRun.get(f.id),
      history: [...(this.history.get(f.id) ?? [])],
    }));
  }

  async runFlow(flowId: string, trigger: 'patrol' | 'manual' = 'manual'): Promise<{ result: FlowRunResult; incidentId?: string }> {
    const flow = FAKE_FLOWS.find((f) => f.id === flowId);
    if (!flow) throw new Error(`unknown flow "${flowId}"`);
    return trigger === 'patrol' ? this.execute(flow, 'patrol', 'patrol') : this.execute(flow, 'manual', 'manual');
  }

  async submitFlag(input: FlagInput): Promise<{ flagId: string; quarantined: boolean; incidentId?: string; reason?: string }> {
    const flagId = newId('flg');
    if (INJECTION.test(input.note)) {
      this.bus.emit({ type: 'log', at: Date.now(), level: 'warn', message: `bug report ${flagId} quarantined by the prompt screen` });
      return { flagId, quarantined: true, reason: 'screened: looks like a prompt-injection attempt' };
    }
    const pathname = safePathname(input.url);
    const flow = FAKE_FLOWS.find((f) => pathname.startsWith(f.path));
    if (!flow) return { flagId, quarantined: false, reason: 'could not map this report to a flow' };
    this.bus.emit({ type: 'log', at: Date.now(), level: 'info', message: `bug report ${flagId} on ${flow.name}: replaying the flow` });
    const { result, incidentId } = await this.execute(flow, 'flag', 'manual');
    if (incidentId) return { flagId, quarantined: false, incidentId };
    return { flagId, quarantined: false, reason: result.ok ? 'could not reproduce: the flow passes' : undefined };
  }

  async listIncidents(): Promise<IncidentSummary[]> {
    const current = [...this.incidents.values()].map((r) => ({ ...r.summary }));
    const past = this.pastSummaries.map((s) => ({ ...s }));
    return [...current, ...past].sort((a, b) => b.openedAt - a.openedAt);
  }

  async getIncident(id: string): Promise<IncidentDetail | undefined> {
    const rec = this.incidents.get(id);
    if (rec) {
      return {
        ...rec.summary,
        events: [...rec.events],
        spans: [...rec.spans],
        patch: rec.patch,
        eval: rec.eval,
        screenshotUrl: rec.screenshotUrl,
      };
    }
    const past = this.pastDetails.get(id);
    return past ? { ...past, events: [...past.events], spans: [...past.spans] } : undefined;
  }

  async approve(incidentId: string, approved: boolean): Promise<void> {
    const rec = this.incidents.get(incidentId);
    if (!rec?.gate) throw new Error('incident is not awaiting approval');
    const gate = rec.gate;
    rec.gate = undefined;
    this.record(rec, { type: 'approval.resolved', at: Date.now(), incidentId, approved });
    gate.resolve(approved ? 'approved' : 'rejected');
  }

  async takeover(incidentId: string): Promise<void> {
    const rec = this.incidents.get(incidentId);
    if (!rec || rec.closed) throw new Error('incident is not active');
    rec.cancel = 'a human took over the incident';
    this.record(rec, { type: 'log', at: Date.now(), incidentId, level: 'warn', message: 'human takeover: autonomous healing stopped' });
    const gate = rec.gate;
    rec.gate = undefined;
    gate?.resolve('takeover');
  }

  async rollback(): Promise<{ restoredVersion: string }> {
    if (this.live === 0) throw new Error('no earlier version to roll back to');
    this.live -= 1;
    this.rollbacks += 1;
    const restored = this.current();
    this.bus.emit({ type: 'store.version', at: Date.now(), version: restored.version, url: this.liveUrl(), note: `rolled back to ${restored.version}` });
    return { restoredVersion: restored.version };
  }

  async reseed(seedId: string): Promise<{ version: string }> {
    const seed = FAKE_SEEDS.find((s) => s.id === seedId);
    if (!seed) throw new Error(`unknown seed "${seedId}"`);
    const version = this.nextVersion();
    this.publish(version, `reseeded: ${seed.title}`, [...new Set([...this.current().bugs, seed.id])]);
    return { version };
  }

  seeds(): { id: string; title: string; flowId: string; description: string }[] {
    return FAKE_SEEDS.map((s) => ({ id: s.id, title: s.title, flowId: s.flowId, description: s.description }));
  }

  async memoryGraph(): Promise<MemoryGraph> {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const f of FAKE_FLOWS) nodes.push({ id: `flow:${f.id}`, type: 'flow', label: f.name });
    for (const b of this.bugs) {
      const label = b.signature.length > 72 ? `${b.signature.slice(0, 69)}...` : b.signature;
      nodes.push({ id: b.id, type: 'bug', label, data: { flowId: b.flowId, severity: b.severity, createdAt: b.createdAt } });
      if (b.flowId) edges.push({ from: b.id, to: `flow:${b.flowId}`, type: 'detected_in' });
    }
    for (const f of this.fixes) {
      nodes.push({ id: f.id, type: 'fix', label: f.summary, data: { verified: f.verified, deployed: f.deployed, score: f.score } });
      edges.push({ from: f.bugId, to: f.id, type: 'fixed_by' });
      for (const file of f.files) edges.push({ from: f.id, to: `file:${file}`, type: 'touches' });
    }
    for (const file of new Set(this.fixes.flatMap((f) => f.files))) {
      nodes.push({ id: `file:${file}`, type: 'file', label: file });
    }
    for (const s of await this.listIncidents()) {
      nodes.push({ id: s.id, type: 'incident', label: s.title, data: { status: s.status, source: s.source } });
      if (s.bugId) edges.push({ from: s.id, to: s.bugId, type: 'about' });
    }
    edges.push(...this.similarLinks);
    return { nodes, edges };
  }

  async stats(): Promise<DashboardStats> {
    const all = await this.listIncidents();
    const healed = all.filter((s) => s.outcome === 'healed');
    const mean = (xs: number[]): number | undefined => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
    return {
      incidents: all.length,
      healed: healed.length,
      bugs: this.bugs.length,
      fixes: this.fixes.length,
      memoryHits: all.filter((s) => s.memoryHit).length,
      rollbacks: this.rollbacks,
      avgHealMs: mean(healed.flatMap((s) => (s.healMs === undefined ? [] : [s.healMs]))),
      avgScore: mean(all.flatMap((s) => (s.score === undefined ? [] : [s.score]))),
      liveVersion: this.current().version,
      patrolling: this.patrolling,
      patrolIntervalSec: this.patrolSec,
    };
  }

  startPatrol(intervalSec?: number): void {
    if (intervalSec !== undefined && intervalSec >= 5) this.patrolSec = intervalSec;
    this.clearPatrolTimer();
    this.patrolling = true;
    this.patrolTimer = setInterval(() => {
      this.patrolTick().catch((err: unknown) => {
        this.bus.emit({ type: 'log', at: Date.now(), level: 'error', message: `patrol tick failed: ${errorMessage(err)}` });
      });
    }, this.patrolSec * 1000);
    this.patrolTimer.unref();
    this.bus.emit({ type: 'log', at: Date.now(), level: 'info', message: `patrol started: critical flows every ${this.patrolSec}s` });
  }

  stopPatrol(): void {
    if (!this.patrolling) return;
    this.clearPatrolTimer();
    this.patrolling = false;
    this.bus.emit({ type: 'log', at: Date.now(), level: 'info', message: 'patrol stopped' });
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.stopPatrol();
  }

  // ───────────────────────────── internals ─────────────────────────────

  private current(): StoreVersion {
    return this.store[this.live]!;
  }

  private nextVersion(): string {
    const [major = 1, minor = 4, patch = 0] = this.store[this.store.length - 1]!.version.split('.').map(Number);
    return `${major}.${minor}.${patch + 1}`;
  }

  /** Make `version` the live version. Forward history is dropped, as after a rollback followed by a deploy. */
  private publish(version: string, note: string, bugs: string[]): void {
    this.store.splice(this.live + 1);
    this.store.push({ version, at: Date.now(), note, bugs });
    this.live = this.store.length - 1;
    this.bus.emit({ type: 'store.version', at: Date.now(), version, url: this.liveUrl(), note });
  }

  private clearPatrolTimer(): void {
    if (this.patrolTimer) clearInterval(this.patrolTimer);
    this.patrolTimer = undefined;
  }

  private async patrolTick(): Promise<void> {
    const flows: { flowId: string; ok: boolean }[] = [];
    for (const flow of FAKE_FLOWS.filter((f) => f.critical)) {
      if (!this.patrolling || this.stopping) return;
      const { result } = await this.execute(flow, 'patrol', 'patrol');
      flows.push({ flowId: flow.id, ok: result.ok });
    }
    this.bus.emit({ type: 'patrol.tick', at: Date.now(), flows, nextInSec: this.patrolSec });
  }

  private brokenScenario(flowId: string): FakeScenario | undefined {
    const live = this.current().bugs;
    return SCENARIOS.find((s) => s.flowId === flowId && live.includes(s.seedId));
  }

  /** Run a flow. If a seeded bug is live for it, open (or join) an incident and heal it in the background. */
  private async execute(
    flow: FakeFlow,
    source: IncidentSource,
    purpose: 'patrol' | 'manual',
  ): Promise<{ result: FlowRunResult; incidentId?: string }> {
    const sc = this.brokenScenario(flow.id);
    if (!sc) return { result: await this.playFlow(flow, { purpose, countInHistory: true }) };

    const error = { message: sc.errorMessage, stack: sc.errorStack };
    const active = [...this.incidents.values()].find((r) => !r.closed && r.scenario.flowId === flow.id);
    if (active) {
      const result = await this.playFlow(flow, { purpose, failAt: sc.failedStep, error, countInHistory: true });
      return { result, incidentId: active.summary.id };
    }

    const rec = this.openIncident(sc, source);
    const result = await this.playFlow(flow, { purpose, rec, failAt: sc.failedStep, error, countInHistory: true });
    rec.screenshotUrl = result.screenshotFile ? `/artifacts/${path.basename(result.screenshotFile)}` : undefined;
    this.stageEnd(rec, 'detect', 'completed', `${flow.name} failed at "${flow.steps[sc.failedStep]}"`);
    void this.heal(rec);
    return { result, incidentId: rec.summary.id };
  }

  private async playFlow(flow: FakeFlow, o: PlayOpts): Promise<FlowRunResult> {
    const incidentId = o.rec?.summary.id;
    const startedAt = Date.now();
    this.record(o.rec, { type: 'flow.started', at: startedAt, incidentId, flowId: flow.id, baseUrl: this.liveUrl(), purpose: o.purpose });
    this.record(o.rec, { type: 'anchor.session', at: Date.now(), incidentId, flowId: flow.id, provider: 'local' });

    const steps: FlowStepResult[] = [];
    let failedStep: number | undefined;
    for (let i = 0; i < flow.steps.length; i++) {
      const durationMs = 420 + ((i * 173 + flow.id.length * 37) % 380);
      await sleep(durationMs);
      const failed = o.failAt === i;
      const step: FlowStepResult = failed
        ? { index: i, name: flow.steps[i]!, ok: false, durationMs, error: o.error?.message ?? 'step failed' }
        : { index: i, name: flow.steps[i]!, ok: true, durationMs };
      steps.push(step);
      this.record(o.rec, { type: 'anchor.step', at: Date.now(), incidentId, flowId: flow.id, step });
      if (failed) {
        failedStep = i;
        break;
      }
    }

    const ok = failedStep === undefined;
    const durationMs = Date.now() - startedAt;
    let screenshotFile: string | undefined;
    let screenshotUrl: string | undefined;
    if (!ok) {
      const name = `${incidentId ?? `${flow.id}-${startedAt}`}-fail`;
      screenshotFile = path.join(this.cfg.artifactsDir, `${name}.png`);
      fs.writeFileSync(screenshotFile, encodePng(640, 340, screenshotPixels('fail')));
      screenshotUrl = `/artifacts/${name}.png`;
    }
    if (o.countInHistory) this.noteRun(flow.id, ok, durationMs);

    const error = !ok && o.error ? { message: o.error.message, stack: o.error.stack } : undefined;
    this.record(o.rec, {
      type: 'flow.completed',
      at: Date.now(),
      incidentId,
      flowId: flow.id,
      ok,
      provider: 'local',
      durationMs,
      purpose: o.purpose,
      failedStep,
      error: error?.message,
      screenshotUrl,
    });
    return {
      flowId: flow.id,
      ok,
      baseUrl: this.liveUrl(),
      provider: 'local',
      steps,
      failedStep,
      error,
      consoleErrors: error ? [error.message] : [],
      pageErrors: error ? [error.stack] : [],
      screenshotFile,
      startedAt,
      durationMs,
    };
  }

  private noteRun(flowId: string, ok: boolean, durationMs: number): void {
    const h = this.history.get(flowId) ?? [];
    h.push(ok);
    if (h.length > 20) h.splice(0, h.length - 20);
    this.history.set(flowId, h);
    this.lastRun.set(flowId, { ok, at: Date.now(), durationMs, provider: 'local' });
  }

  private openIncident(sc: FakeScenario, source: IncidentSource): Rec {
    const id = newId('inc');
    const now = Date.now();
    const traceId = hex(16);
    const rec: Rec = {
      summary: {
        id,
        title: sc.title,
        status: 'open',
        source,
        flowId: sc.flowId,
        severity: sc.severity,
        openedAt: now,
        traceId,
        error: sc.errorMessage,
      },
      scenario: sc,
      events: [],
      spans: [],
      traceId,
      rootSpanId: hex(8),
      stageSpanIds: {},
      stageStarted: {},
      closed: false,
    };
    this.incidents.set(id, rec);
    this.record(rec, {
      type: 'incident.opened',
      at: now,
      incidentId: id,
      title: sc.title,
      source,
      flowId: sc.flowId,
      error: sc.errorMessage,
      severity: sc.severity,
      traceId,
    });
    this.stageStart(rec, 'detect');
    return rec;
  }

  private record(rec: Rec | undefined, event: IncidentEvent): void {
    rec?.events.push(event);
    this.bus.emit(event);
  }

  private stageStart(rec: Rec, stage: Stage): void {
    rec.currentStage = stage;
    rec.stageStarted[stage] = Date.now();
    rec.stageSpanIds[stage] = hex(8);
    this.record(rec, { type: 'stage.changed', at: Date.now(), incidentId: rec.summary.id, stage, sponsor: STAGE_SPONSOR[stage], status: 'started' });
  }

  private stageEnd(rec: Rec, stage: Stage, status: 'completed' | 'skipped', detail?: string): void {
    const now = Date.now();
    this.record(rec, { type: 'stage.changed', at: now, incidentId: rec.summary.id, stage, sponsor: STAGE_SPONSOR[stage], status, detail });
    rec.spans.push({
      traceId: rec.traceId,
      spanId: rec.stageSpanIds[stage] ?? hex(8),
      parentSpanId: rec.rootSpanId,
      name: `stage.${stage}`,
      kind: 'CHAIN',
      startMs: rec.stageStarted[stage] ?? now,
      endMs: now,
      status: status === 'skipped' ? 'unset' : 'ok',
      attributes: { 'healops.stage': stage, 'healops.sponsor': STAGE_SPONSOR[stage], 'healops.detail': detail ?? '' },
    });
    if (rec.currentStage === stage) rec.currentStage = undefined;
  }

  private childSpan(
    rec: Rec,
    name: string,
    kind: RecordedSpan['kind'],
    startMs: number,
    attributes: RecordedSpan['attributes'],
    stage: Stage,
  ): void {
    rec.spans.push({
      traceId: rec.traceId,
      spanId: hex(8),
      parentSpanId: rec.stageSpanIds[stage] ?? rec.rootSpanId,
      name,
      kind,
      startMs,
      endMs: Date.now(),
      status: 'ok',
      attributes,
    });
  }

  private async stage(rec: Rec, stage: Stage, body: () => Promise<string | undefined>): Promise<void> {
    this.stageStart(rec, stage);
    let detail: string | undefined;
    try {
      detail = await body();
    } catch (err) {
      if (err instanceof Stop) this.stageEnd(rec, stage, 'skipped', err.note);
      throw err;
    }
    this.stageEnd(rec, stage, 'completed', detail);
  }

  /** Sleep, then stop the incident if a takeover or shutdown happened meanwhile. */
  private async pause(rec: Rec, ms: number): Promise<void> {
    await sleep(ms);
    if (this.stopping) throw new Stop('failed', 'runtime shut down');
    if (rec.cancel) throw new Stop('escalated', rec.cancel);
  }

  private close(rec: Rec, outcome: IncidentOutcome, note: string): void {
    if (rec.closed) return;
    rec.closed = true;
    const now = Date.now();
    rec.summary.status = outcome;
    rec.summary.outcome = outcome;
    rec.summary.closedAt = now;
    rec.summary.healMs = now - rec.summary.openedAt;
    rec.spans.unshift({
      traceId: rec.traceId,
      spanId: rec.rootSpanId,
      name: 'healops.incident',
      kind: 'AGENT',
      startMs: rec.summary.openedAt,
      endMs: now,
      status: outcome === 'healed' ? 'ok' : 'unset',
      attributes: { 'healops.incident_id': rec.summary.id, 'healops.outcome': outcome },
    });
    if (this.stopping) return;
    this.record(rec, {
      type: 'incident.closed',
      at: now,
      incidentId: rec.summary.id,
      outcome,
      durationMs: now - rec.summary.openedAt,
      score: rec.summary.score,
      summary: note,
    });
  }

  /** The scripted heal: triage -> recall -> reproduce -> patch -> verify -> gate -> deploy -> judge -> learn. */
  private async heal(rec: Rec): Promise<void> {
    const sc = rec.scenario;
    const id = rec.summary.id;
    const models = this.modes.models;
    try {
      rec.summary.status = 'healing';

      await this.stage(rec, 'triage', async () => {
        await this.pause(rec, 700);
        this.record(rec, {
          type: 'triage.result',
          at: Date.now(),
          incidentId: id,
          safe: true,
          guard: this.modes.guardrails,
          severity: sc.severity,
          category: sc.category,
          summary: sc.triageSummary,
        });
        return `${sc.severity}, ${sc.category}`;
      });

      await this.stage(rec, 'recall', async () => {
        const started = Date.now();
        await this.pause(rec, 450);
        const best = sc.memoryMatches[0];
        this.record(rec, {
          type: 'memory.match',
          at: Date.now(),
          incidentId: id,
          bugId: sc.bugId,
          matches: sc.memoryMatches.map((m) => ({ ...m })),
        });
        if (best) rec.similar = { bugId: best.bugId, similarity: best.similarity };
        if (best && best.similarity >= 0.85) rec.summary.memoryHit = best.bugId;
        this.childSpan(rec, 'surreal.similar_bugs', 'RETRIEVER', started, { 'db.system': 'surrealdb', 'healops.matches': sc.memoryMatches.length }, 'recall');
        return best ? `closest ${best.bugId} at ${best.similarity.toFixed(2)}` : 'no prior bug matched';
      });

      await this.stage(rec, 'reproduce', async () => {
        const sandboxId = `sbx_${hex(4)}`;
        rec.sandboxId = sandboxId;
        await this.pause(rec, 350);
        this.record(rec, { type: 'sandbox.created', at: Date.now(), incidentId: id, sandboxId, provider: this.modes.sandbox });
        const started = Date.now();
        for (const line of sc.reproLog) {
          await this.pause(rec, 230);
          this.record(rec, { type: 'sandbox.log', at: Date.now(), incidentId: id, sandboxId, line });
        }
        const durationMs = Date.now() - started;
        this.childSpan(rec, 'daytona.exec node --test', 'TOOL', started, { 'sandbox.id': sandboxId, 'exec.exit_code': 1 }, 'reproduce');
        this.record(rec, { type: 'sandbox.result', at: Date.now(), incidentId: id, sandboxId, phase: 'reproduce', passed: false, summary: sc.reproSummary, durationMs });
        return 'bug reproduced in the sandbox';
      });

      await this.stage(rec, 'patch', async () => {
        const started = Date.now();
        for (const chunk of sc.thinking) {
          await this.pause(rec, 240);
          this.record(rec, { type: 'llm.delta', at: Date.now(), incidentId: id, kind: 'thinking', text: `${chunk} `, model: models.patch });
        }
        for (const chunk of sc.textChunks) {
          await this.pause(rec, 200);
          this.record(rec, { type: 'llm.delta', at: Date.now(), incidentId: id, kind: 'text', text: chunk, model: models.patch });
        }
        await this.pause(rec, 250);
        const diff = cleanDiff(unifiedDiff(sc.file, sc.before, sc.after));
        rec.patch = { summary: sc.fixSummary, rootCause: sc.rootCause, diff, confidence: sc.confidence, model: models.patch };
        this.record(rec, {
          type: 'patch.ready',
          at: Date.now(),
          incidentId: id,
          attempt: 1,
          summary: sc.fixSummary,
          rootCause: sc.rootCause,
          reasoning: sc.reasoning,
          confidence: sc.confidence,
          diff,
          files: [sc.file],
          model: models.patch,
          provider: this.modes.llm,
        });
        this.childSpan(rec, 'bedrock.converse patch', 'LLM', started, { 'gen_ai.request.model': models.patch, 'gen_ai.usage.input_tokens': 9120, 'gen_ai.usage.output_tokens': 1480 }, 'patch');
        return `attempt 1, confidence ${sc.confidence}`;
      });

      await this.stage(rec, 'verify', async () => {
        const sandboxId = rec.sandboxId ?? `sbx_${hex(4)}`;
        const started = Date.now();
        for (const line of sc.verifyLog) {
          await this.pause(rec, 210);
          this.record(rec, { type: 'sandbox.log', at: Date.now(), incidentId: id, sandboxId, line });
        }
        const flow = FAKE_FLOWS.find((f) => f.id === sc.flowId)!;
        const replay = await this.playFlow(flow, { purpose: 'verify', rec, countInHistory: false });
        this.record(rec, { type: 'sandbox.result', at: Date.now(), incidentId: id, sandboxId, phase: 'verify', passed: replay.ok, summary: sc.verifySummary, durationMs: Date.now() - started });
        return replay.ok ? `${flow.name} replay passed` : undefined;
      });

      await this.stage(rec, 'gate', async () => {
        const needsApproval = sc.flowId === 'signup' || rec.summary.source === 'flag';
        const risk = needsApproval ? Math.max(sc.risk, 58) : sc.risk;
        const reasons = rec.summary.source === 'flag' ? [...sc.reasons, 'reported by a user through the flag widget'] : sc.reasons;
        await this.pause(rec, 350);
        this.record(rec, {
          type: 'gate.decision',
          at: Date.now(),
          incidentId: id,
          risk,
          decision: needsApproval ? 'needs_approval' : 'auto',
          reasons,
          preScore: sc.preScore,
        });
        if (!needsApproval) return `auto-applied, risk ${risk}`;
        rec.summary.status = 'awaiting_approval';
        this.record(rec, { type: 'log', at: Date.now(), incidentId: id, level: 'info', message: 'waiting for a reviewer to approve the fix', sponsor: 'arize' });
        const verdict = await new Promise<Verdict>((resolve) => {
          rec.gate = { resolve };
        });
        if (verdict === 'takeover') throw new Stop('escalated', rec.cancel ?? 'a human took over the incident');
        if (verdict === 'rejected') throw new Stop('rejected', 'fix rejected by a reviewer');
        rec.summary.status = 'healing';
        return `approved by a reviewer, risk ${risk}`;
      });

      await this.stage(rec, 'deploy', async () => {
        const version = this.nextVersion();
        await this.pause(rec, 400);
        this.record(rec, { type: 'deploy.progress', at: Date.now(), incidentId: id, phase: 'canary', version, ok: true, url: this.liveUrl(), detail: 'canary live for 10% of sessions', provider: this.modes.deploy });
        await this.pause(rec, 900);
        this.record(rec, { type: 'deploy.progress', at: Date.now(), incidentId: id, phase: 'smoke', version, ok: true, detail: '12 of 12 smoke checks passed', provider: this.modes.deploy });
        await this.pause(rec, 650);
        this.record(rec, { type: 'deploy.progress', at: Date.now(), incidentId: id, phase: 'promoted', version, ok: true, url: this.liveUrl(), detail: 'promoted to live', provider: this.modes.deploy });
        this.publish(version, sc.deployNote, this.current().bugs.filter((b) => b !== sc.seedId));
        return `live ${version}`;
      });

      await this.stage(rec, 'judge', async () => {
        const started = Date.now();
        await this.pause(rec, 900);
        rec.eval = { score: sc.score, rubric: sc.rubric, verdict: sc.verdict, model: models.judge };
        rec.summary.score = sc.score;
        this.record(rec, { type: 'eval.scored', at: Date.now(), incidentId: id, score: sc.score, rubric: sc.rubric, verdict: sc.verdict, model: models.judge });
        this.childSpan(rec, 'arize.judge', 'EVALUATOR', started, { 'llm.model_name': models.judge, 'eval.score': sc.score }, 'judge');
        return `score ${sc.score}/100`;
      });

      await this.stage(rec, 'learn', async () => {
        await this.pause(rec, 500);
        const now = Date.now();
        const bugId = newId('bug');
        const fixId = newId('fix');
        this.bugs.push({ id: bugId, incidentId: id, signature: sc.signature, flowId: sc.flowId, errorMessage: sc.errorMessage, stack: sc.errorStack, severity: sc.severity, createdAt: now });
        this.fixes.push({
          id: fixId,
          bugId,
          incidentId: id,
          summary: sc.fixSummary,
          rootCause: sc.rootCause,
          diff: rec.patch?.diff ?? '',
          files: [sc.file],
          verified: true,
          deployed: true,
          score: sc.score,
          createdAt: now,
        });
        rec.summary.bugId = bugId;
        rec.summary.fixId = fixId;
        if (rec.similar) this.similarLinks.push({ from: bugId, to: rec.similar.bugId, type: 'similar_to', weight: rec.similar.similarity });
        this.record(rec, { type: 'memory.learned', at: now, incidentId: id, bugId, fixId, edges: 4 + (rec.similar ? 1 : 0) });
        return `learned ${bugId}`;
      });

      this.close(rec, 'healed', sc.summary);
    } catch (err) {
      if (err instanceof Stop) {
        this.close(rec, err.outcome, err.note);
      } else {
        this.record(rec, { type: 'log', at: Date.now(), incidentId: id, level: 'error', message: `healing stopped: ${errorMessage(err)}` });
        this.close(rec, 'failed', errorMessage(err));
      }
    }
  }

  private seedPast(now: number): void {
    for (const p of PAST_INCIDENTS) {
      const openedAt = now - p.ageDays * DAY_MS;
      const closedAt = openedAt + p.durationSec * 1000;
      const summary: IncidentSummary = {
        id: p.id,
        title: p.title,
        status: p.outcome,
        source: p.source,
        flowId: p.flowId,
        severity: p.severity,
        openedAt,
        closedAt,
        outcome: p.outcome,
        score: p.score,
        memoryHit: p.memoryHit,
        healMs: p.durationSec * 1000,
        bugId: p.bugId,
        fixId: p.fixId,
        error: p.error,
      };
      const events: IncidentEvent[] = [
        { type: 'incident.opened', at: openedAt, incidentId: p.id, title: p.title, source: p.source, flowId: p.flowId, error: p.error, severity: p.severity },
        { type: 'incident.closed', at: closedAt, incidentId: p.id, outcome: p.outcome, durationMs: p.durationSec * 1000, score: p.score, summary: p.note },
      ];
      const fix = PAST_FIXES.find((f) => f.id === p.fixId);
      this.pastSummaries.push(summary);
      this.pastDetails.set(p.id, {
        ...summary,
        events,
        spans: [],
        patch: fix && p.outcome === 'healed' ? { summary: fix.summary, rootCause: fix.rootCause, diff: fix.diff, confidence: 0.9, model: 'claude-opus-5-5' } : undefined,
        eval: p.score === undefined
          ? undefined
          : { score: p.score, rubric: { correctness: 0.9, minimality: 0.9, testCoverage: 0.85, safety: 0.95, memoryUse: p.memoryHit ? 0.9 : 0.5 }, verdict: p.note, model: 'claude-haiku-5-5' },
      });
    }
    for (const b of PAST_BUGS) {
      this.bugs.push({
        id: b.id,
        incidentId: PAST_INCIDENTS.find((i) => i.bugId === b.id)?.id ?? '',
        signature: b.signature,
        flowId: b.flowId,
        errorMessage: b.errorMessage,
        severity: b.severity,
        createdAt: now - b.ageDays * DAY_MS,
      });
    }
    for (const f of PAST_FIXES) {
      this.fixes.push({
        id: f.id,
        bugId: f.bugId,
        incidentId: PAST_INCIDENTS.find((i) => i.fixId === f.id)?.id ?? '',
        summary: f.summary,
        rootCause: f.rootCause,
        diff: f.diff,
        files: f.files,
        verified: true,
        deployed: true,
        score: f.score,
        createdAt: now - f.ageDays * DAY_MS,
      });
    }
  }
}

/** In-memory runtime for development and smoke tests. Needs no credentials and contacts no service. */
export function createFakeRuntime(): HealOpsRuntime {
  return new FakeRuntime();
}
