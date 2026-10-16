import path from 'node:path';
import {
  EventBus, errorMessage, newId, truncate,
  type DashboardStats, type FlagInput, type FlowDefinition, type FlowInfo, type FlowRunResult, type HealOpsRuntime,
  type IncidentDetail, type IncidentEvent, type IncidentSource, type IncidentSummary, type MemoryGraph, type ProviderModes,
} from '@healops/shared';
import {
  ACTIVE_STATUSES, Closed, closeRecord, log, soft, softSync, toSummary,
  type EventInput, type FlowPurpose, type Heal, type Hub, type IncidentRecord,
} from './context.js';
import type { RuntimeDeps } from './deps.js';
import { chooseFlows, pushHistory } from './flags.js';
import { detect, recall, triage } from './intake.js';
import { patchAndVerify } from './patch.js';
import { deploy, gate, judge, learn } from './release.js';
import { reproduce } from './reproduce.js';
import { skipRemaining } from './stage.js';
import { patchBump } from './version.js';

/** Compare "1.4.10" > "1.4.9" numerically; non-numeric parts compare as 0. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

class Runtime implements HealOpsRuntime, Hub {
  readonly bus: EventBus;
  readonly modes: ProviderModes;

  private readonly incidents = new Map<string, IncidentRecord>();
  private readonly flowState = new Map<string, { lastRun?: FlowInfo['lastRun']; history: boolean[] }>();
  private readonly running = new Set<Promise<void>>();
  private patrolTimer?: NodeJS.Timeout;
  private patrolSec: number;
  private patrolBusy = false;
  private rollbacks = 0;
  private stopping = false;

  constructor(readonly deps: RuntimeDeps) {
    this.bus = deps.bus ?? new EventBus();
    this.patrolSec = deps.config.patrolIntervalSec;
    this.modes = {
      browser: deps.browser.provider,
      sandbox: deps.sandboxes.provider,
      memory: deps.memory.provider,
      llm: deps.llm.provider,
      guardrails: deps.llm.guardrails,
      telemetry: deps.telemetry.provider,
      deploy: deps.deployer.provider,
      models: deps.llm.models,
    };
    for (const f of deps.flows) this.flowState.set(f.id, { history: [] });
  }

  // ───────────────────────────── Hub ─────────────────────────────

  emit(event: EventInput): void {
    this.bus.emit({ ...event, at: Date.now() } as IncidentEvent);
  }

  async persist(rec: IncidentRecord): Promise<void> {
    await soft('memory.upsertIncident', () => this.deps.memory.upsertIncident(toSummary(rec)));
  }

  async runFlow(flow: FlowDefinition, purpose: FlowPurpose, incidentId: string | undefined, baseUrl: string): Promise<FlowRunResult>;
  async runFlow(flowId: string, trigger?: 'patrol' | 'manual'): Promise<{ result: FlowRunResult; incidentId?: string }>;
  async runFlow(
    a: FlowDefinition | string,
    b?: FlowPurpose,
    incidentId?: string,
    baseUrl?: string,
  ): Promise<FlowRunResult | { result: FlowRunResult; incidentId?: string }> {
    if (typeof a === 'string') return this.runLiveFlow(a, (b as 'patrol' | 'manual' | undefined) ?? 'manual');
    return this.execFlow(a, b ?? 'manual', incidentId, baseUrl ?? this.liveUrl());
  }

  private async execFlow(flow: FlowDefinition, purpose: FlowPurpose, incidentId: string | undefined, baseUrl: string): Promise<FlowRunResult> {
    this.emit({ type: 'flow.started', incidentId, flowId: flow.id, baseUrl, purpose });
    const result = await this.deps.browser.runFlow(flow, {
      baseUrl,
      artifactsDir: this.deps.config.artifactsDir,
      onStep: (step) => this.emit({ type: 'anchor.step', incidentId, flowId: flow.id, step }),
      onSession: (info) => this.emit({ type: 'anchor.session', incidentId, flowId: flow.id, ...info }),
    });
    const screenshotUrl = result.screenshotFile ? `/artifacts/${path.basename(result.screenshotFile)}` : undefined;
    this.emit({
      type: 'flow.completed', incidentId, flowId: flow.id, ok: result.ok, provider: result.provider,
      durationMs: result.durationMs, failedStep: result.failedStep, error: result.error?.message, screenshotUrl, purpose,
    });
    return result;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async init(): Promise<void> {
    const { memory, llm, deployer, site, seedHistory } = this.deps;
    await memory.init();
    if (seedHistory) {
      const n = await soft('seedHistory', () => seedHistory(memory, (t) => llm.embed(t)));
      if (n) log.info(`memory seeded with ${n} past bug(s)`);
    }
    let files = site.loadSite();
    if (site.defaultSeed) files = site.applySeed(files, site.defaultSeed);
    await deployer.bootstrap(files, site.version);
    const version = await deployer.currentVersion();
    this.emit({
      type: 'log', level: 'info',
      message: `runtime ready: browser ${this.modes.browser}, sandbox ${this.modes.sandbox}, memory ${this.modes.memory}, llm ${this.modes.llm}, deploy ${this.modes.deploy}`,
    });
    this.emit({ type: 'store.version', version, url: this.liveUrl(), note: 'live' });
  }

  liveUrl(): string {
    return this.deps.deployer.liveUrl();
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.stopPatrol();
    for (const rec of this.incidents.values()) {
      if (rec.closedAt !== undefined) continue;
      rec.abort = true;
      rec.approval?.settle(false);
    }
    await Promise.race([Promise.allSettled([...this.running]), new Promise((r) => setTimeout(r, 3000).unref())]);
    const { browser, memory, deployer, telemetry } = this.deps;
    await soft('browser.close', () => browser.close());
    await soft('deployer.close', () => deployer.close());
    await soft('telemetry.shutdown', () => telemetry.shutdown());
    await soft('memory.close', () => memory.close());
  }

  // ───────────────────────────── flows ─────────────────────────────

  listFlows(): FlowInfo[] {
    return this.deps.flows.map((f) => {
      const st = this.flowState.get(f.id);
      return {
        id: f.id, name: f.name, description: f.description, critical: f.critical,
        lastRun: st?.lastRun, history: [...(st?.history ?? [])],
      };
    });
  }

  private flow(flowId: string): FlowDefinition {
    const flow = this.deps.flows.find((f) => f.id === flowId);
    if (!flow) throw new Error(`unknown flow "${flowId}"`);
    return flow;
  }

  private activeFor(flowId: string): IncidentRecord | undefined {
    for (const rec of this.incidents.values()) {
      if (rec.flowId === flowId && rec.closedAt === undefined && ACTIVE_STATUSES.includes(rec.status)) return rec;
    }
    return undefined;
  }

  private record(flowId: string, result: FlowRunResult): void {
    const st = this.flowState.get(flowId) ?? { history: [] };
    st.history = pushHistory(st.history, result.ok);
    st.lastRun = { ok: result.ok, at: result.startedAt, durationMs: result.durationMs, provider: result.provider };
    this.flowState.set(flowId, st);
  }

  private async runLiveFlow(flowId: string, trigger: 'patrol' | 'manual'): Promise<{ result: FlowRunResult; incidentId?: string }> {
    const flow = this.flow(flowId);
    const result = await this.execFlow(flow, trigger, undefined, this.liveUrl());
    this.record(flow.id, result);
    if (result.ok) return { result };
    const active = this.activeFor(flow.id);
    if (active) return { result, incidentId: active.id };
    const rec = this.open(flow, result, trigger);
    return { result, incidentId: rec.id };
  }

  async submitFlag(input: FlagInput): Promise<{ flagId: string; quarantined: boolean; incidentId?: string; reason?: string }> {
    const flagId = newId('flg');
    const screened = await this.deps.llm.screen(input.note, 'flag');
    if (!screened.safe) {
      this.emit({ type: 'log', level: 'warn', message: `bug report ${flagId} quarantined by ${screened.provider}: ${screened.reason ?? 'unsafe'}` });
      return { flagId, quarantined: true, reason: screened.reason ?? 'report failed the safety screen' };
    }
    const candidates = chooseFlows(input.note, input.url, this.deps.flows);
    this.emit({ type: 'log', level: 'info', message: `bug report ${flagId}: replaying ${candidates.map((f) => f.name).join(', ') || 'no flows'}` });
    const report = [
      input.note,
      input.consoleErrors?.length ? `console errors: ${input.consoleErrors.slice(0, 5).join(' | ')}` : '',
      `page: ${input.url}`,
    ].filter(Boolean).join('\n');
    for (const flow of candidates) {
      const result = await this.execFlow(flow, 'manual', undefined, this.liveUrl());
      this.record(flow.id, result);
      if (result.ok) continue;
      const active = this.activeFor(flow.id);
      if (active) return { flagId, quarantined: false, incidentId: active.id };
      const rec = this.open(flow, result, 'flag', truncate(report, 2000));
      return { flagId, quarantined: false, incidentId: rec.id };
    }
    return { flagId, quarantined: false, reason: 'could not reproduce: the related flows pass' };
  }

  // ───────────────────────────── incidents ─────────────────────────────

  private open(flow: FlowDefinition, failing: FlowRunResult, source: IncidentSource, userReport?: string): IncidentRecord {
    const { telemetry } = this.deps;
    const id = newId('inc');
    const error = failing.error?.message ?? 'flow failed';
    const step = failing.steps.find((s) => s.index === failing.failedStep);
    const rootSpan = softSync('telemetry.startSpan', () =>
      telemetry.startSpan('heal_incident', {
        kind: 'AGENT',
        attributes: { 'healops.incident_id': id, 'healops.flow_id': flow.id, 'healops.source': source, 'input.value': truncate(error, 2000) },
      }),
    );
    const rec: IncidentRecord = {
      id,
      title: `${flow.name} broken${step ? ` at "${step.name}"` : ''}`,
      source,
      flowId: flow.id,
      error: truncate(error, 500),
      severity: flow.critical ? 'sev2' : 'sev3',
      status: 'open',
      openedAt: Date.now(),
      userReport,
      traceId: rootSpan?.traceId,
      traceUrl: rootSpan ? softSync('telemetry.traceUrl', () => telemetry.traceUrl(rootSpan.traceId)) : undefined,
      screenshotUrl: failing.screenshotFile ? `/artifacts/${path.basename(failing.screenshotFile)}` : undefined,
      abort: false,
    };
    this.incidents.set(id, rec);
    this.emit({
      type: 'incident.opened', incidentId: id, title: rec.title, source, flowId: flow.id,
      error: rec.error, severity: rec.severity, traceId: rec.traceId,
    });
    const h: Heal = {
      hub: this, rec, failing, flow, rootSpan, started: new Set(), liveFiles: [], similar: [], similarFixes: [],
      reproOutput: '', attempts: 0, previousAttempts: [], links: 0, deployOutcome: 'promoted',
    };
    const p = this.heal(h).finally(() => this.running.delete(p));
    this.running.add(p);
    return rec;
  }

  private async heal(h: Heal): Promise<void> {
    const { rec } = h;
    rec.status = 'healing';
    await this.persist(rec);
    let outcome: 'healed' | Closed | Error = 'healed';
    try {
      await detect(h);
      await triage(h);
      await recall(h);
      await reproduce(h);
      const { proposal, applied } = await patchAndVerify(h);
      await gate(h, proposal, applied);
      await deploy(h, applied, () => this.nextVersion());
      await judge(h, proposal, applied);
      await learn(h, proposal, applied);
      // prove the fix on the live store, and record the green run in the flow's history
      const live = await soft('live re-check', () => this.execFlow(h.flow!, 'smoke', rec.id, this.liveUrl()));
      if (live) this.record(live.flowId, live);
    } catch (err) {
      outcome = err instanceof Closed ? err : err instanceof Error ? err : new Error(errorMessage(err));
    }

    if (outcome === 'healed') {
      await closeRecord(this, rec, 'healed', rec.patch?.summary ?? 'healed');
    } else if (outcome instanceof Closed) {
      skipRemaining(h, outcome.message);
      await closeRecord(this, rec, outcome.outcome, outcome.message);
    } else {
      log.error(`incident ${rec.id} failed: ${outcome.message}`);
      this.emit({ type: 'log', incidentId: rec.id, level: 'error', message: `heal failed: ${outcome.message}` });
      skipRemaining(h, outcome.message);
      await closeRecord(this, rec, 'failed', outcome.message);
    }
    if (rec.outcome === 'rolled_back') this.rollbacks++;

    softSync('span.attrs', () =>
      h.rootSpan?.setAttributes({ 'healops.outcome': rec.outcome, 'healops.score': rec.score, 'output.value': rec.patch?.summary }),
    );
    if (rec.outcome === 'failed') softSync('span.fail', () => h.rootSpan?.fail(outcome));
    softSync('span.end', () => h.rootSpan?.end());
    if (h.sandbox) await soft('sandbox.destroy', () => h.sandbox!.destroy());
    await soft('telemetry.flush', () => this.deps.telemetry.flush());
  }

  private async nextVersion(): Promise<string> {
    const { deployer } = this.deps;
    const versions = [await deployer.currentVersion(), ...((await soft('deployer.history', () => deployer.history())) ?? []).map((v) => v.version)];
    const max = versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
    return patchBump(max);
  }

  async listIncidents(): Promise<IncidentSummary[]> {
    const byId = new Map<string, IncidentSummary>();
    for (const s of (await soft('memory.listIncidents', () => this.deps.memory.listIncidents(100))) ?? []) byId.set(s.id, s);
    for (const rec of this.incidents.values()) byId.set(rec.id, toSummary(rec));
    return [...byId.values()].sort((a, b) => b.openedAt - a.openedAt);
  }

  async getIncident(id: string): Promise<IncidentDetail | undefined> {
    const rec = this.incidents.get(id);
    const summary = rec ? toSummary(rec) : (await this.listIncidents()).find((s) => s.id === id);
    if (!summary) return undefined;
    const traceId = summary.traceId;
    return {
      ...summary,
      events: this.bus.forIncident(id),
      spans: traceId ? (softSync('telemetry.spans', () => this.deps.telemetry.spans(traceId)) ?? []) : [],
      patch: rec?.patch,
      eval: rec?.eval,
      screenshotUrl: rec?.screenshotUrl,
    };
  }

  async approve(incidentId: string, approved: boolean): Promise<void> {
    const rec = this.incidents.get(incidentId);
    if (!rec?.approval) throw new Error('incident is not awaiting approval');
    const approval = rec.approval;
    rec.approval = undefined;
    this.emit({ type: 'approval.resolved', incidentId, approved });
    approval.settle(approved);
  }

  async takeover(incidentId: string): Promise<void> {
    const rec = this.incidents.get(incidentId);
    if (!rec || rec.closedAt !== undefined) throw new Error('incident is not active');
    rec.abort = true;
    this.emit({ type: 'log', incidentId, level: 'warn', message: 'human takeover: autonomous healing stopped' });
    const approval = rec.approval;
    await closeRecord(this, rec, 'escalated', 'a human took over');
    approval?.settle(false);
  }

  // ───────────────────────────── store ─────────────────────────────

  async rollback(): Promise<{ restoredVersion: string }> {
    const res = await this.deps.deployer.rollback();
    this.rollbacks++;
    this.emit({ type: 'store.version', version: res.restoredVersion, url: this.liveUrl(), note: `rolled back to ${res.restoredVersion}` });
    return res;
  }

  async reseed(seedId: string): Promise<{ version: string }> {
    const { site, deployer } = this.deps;
    const seed = site.seeds.find((s) => s.id === seedId);
    if (!seed) throw new Error(`unknown seed "${seedId}"`);
    const files = site.applySeed(await deployer.liveFiles(), seedId);
    const version = await this.nextVersion();
    const note = `reseeded: ${seed.title}`;
    await deployer.publish(files, version, note);
    this.emit({ type: 'store.version', version, url: this.liveUrl(), note });
    return { version };
  }

  seeds(): { id: string; title: string; flowId: string; description: string }[] {
    return this.deps.site.seeds.map((s) => ({ id: s.id, title: s.title, flowId: s.flowId, description: s.description }));
  }

  async memoryGraph(): Promise<MemoryGraph> {
    return (await soft('memory.graph', () => this.deps.memory.graph())) ?? { nodes: [], edges: [] };
  }

  async stats(): Promise<DashboardStats> {
    const base = (await soft('memory.stats', () => this.deps.memory.stats())) ?? {
      incidents: 0, healed: 0, bugs: 0, fixes: 0, memoryHits: 0, rollbacks: 0,
    };
    return {
      ...base,
      rollbacks: Math.max(base.rollbacks, this.rollbacks),
      liveVersion: (await soft('deployer.currentVersion', () => this.deps.deployer.currentVersion())) ?? '?',
      patrolling: this.patrolTimer !== undefined,
      patrolIntervalSec: this.patrolSec,
    };
  }

  // ───────────────────────────── patrol ─────────────────────────────

  startPatrol(intervalSec?: number): void {
    if (intervalSec !== undefined && intervalSec >= 5) this.patrolSec = intervalSec;
    if (this.patrolTimer) clearInterval(this.patrolTimer);
    this.patrolTimer = setInterval(() => void this.patrolTick(), this.patrolSec * 1000);
    this.patrolTimer.unref();
    this.emit({ type: 'log', level: 'info', message: `patrol started: critical flows every ${this.patrolSec}s` });
  }

  stopPatrol(): void {
    if (!this.patrolTimer) return;
    clearInterval(this.patrolTimer);
    this.patrolTimer = undefined;
    this.emit({ type: 'log', level: 'info', message: 'patrol stopped' });
  }

  private async patrolTick(): Promise<void> {
    if (this.patrolBusy || this.stopping) return;
    this.patrolBusy = true;
    const flows: { flowId: string; ok: boolean }[] = [];
    try {
      for (const f of this.deps.flows.filter((x) => x.critical)) {
        if (this.stopping) break;
        // a flow already being healed is skipped: its incident owns the next runs
        if (this.activeFor(f.id)) continue;
        try {
          const { result } = await this.runLiveFlow(f.id, 'patrol');
          flows.push({ flowId: f.id, ok: result.ok });
        } catch (err) {
          this.emit({ type: 'log', level: 'error', message: `patrol run of ${f.id} failed: ${errorMessage(err)}` });
        }
      }
      this.emit({ type: 'patrol.tick', flows, nextInSec: this.patrolSec });
    } finally {
      this.patrolBusy = false;
    }
  }
}

/** Build the HealOps orchestrator from injected adapters. */
export function createRuntime(deps: RuntimeDeps): HealOpsRuntime {
  return new Runtime(deps);
}
