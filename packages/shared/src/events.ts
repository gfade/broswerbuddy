/**
 * The event stream is the single source of truth for the UI: the dashboard
 * renders purely from these events (live over WebSocket, or replayed).
 * Every event carries `at` (epoch ms).
 */
import type {
  EvalRubric, FlowStepResult, IncidentOutcome, IncidentSource, ProviderModes, Severity, Sponsor, Stage,
} from './types.js';

export type IncidentEvent =
  | { type: 'incident.opened'; at: number; incidentId: string; title: string; source: IncidentSource; flowId?: string; error: string; severity: Severity; traceId?: string }
  | { type: 'stage.changed'; at: number; incidentId: string; stage: Stage; sponsor: Sponsor; status: 'started' | 'completed' | 'failed' | 'skipped'; detail?: string }
  | { type: 'flow.started'; at: number; incidentId?: string; flowId: string; baseUrl: string; purpose: 'patrol' | 'manual' | 'reproduce' | 'verify' | 'smoke' }
  | { type: 'anchor.session'; at: number; incidentId?: string; flowId: string; provider: 'anchor' | 'local'; sessionId?: string; liveViewUrl?: string }
  | { type: 'anchor.step'; at: number; incidentId?: string; flowId: string; step: FlowStepResult }
  | { type: 'flow.completed'; at: number; incidentId?: string; flowId: string; ok: boolean; provider: 'anchor' | 'local'; durationMs: number; failedStep?: number; error?: string; screenshotUrl?: string; purpose: 'patrol' | 'manual' | 'reproduce' | 'verify' | 'smoke' }
  | { type: 'triage.result'; at: number; incidentId: string; safe: boolean; guard: string; severity: Severity; category: string; summary: string; reason?: string }
  | { type: 'memory.match'; at: number; incidentId: string; bugId: string; matches: { bugId: string; similarity: number; signature: string; fixSummary?: string; score?: number }[] }
  | { type: 'sandbox.created'; at: number; incidentId: string; sandboxId: string; provider: 'daytona' | 'local' }
  | { type: 'sandbox.log'; at: number; incidentId: string; sandboxId: string; line: string }
  | { type: 'sandbox.result'; at: number; incidentId: string; sandboxId: string; phase: 'reproduce' | 'verify'; passed: boolean; summary: string; durationMs: number; previewUrl?: string }
  | { type: 'llm.delta'; at: number; incidentId: string; kind: 'thinking' | 'text'; text: string; model: string }
  | { type: 'patch.ready'; at: number; incidentId: string; attempt: number; summary: string; rootCause: string; reasoning: string[]; confidence: number; diff: string; files: string[]; model: string; provider: string }
  | { type: 'patch.rejected'; at: number; incidentId: string; attempt: number; reason: string }
  | { type: 'gate.decision'; at: number; incidentId: string; risk: number; decision: 'auto' | 'needs_approval' | 'blocked'; reasons: string[]; preScore?: number }
  | { type: 'approval.resolved'; at: number; incidentId: string; approved: boolean }
  | { type: 'deploy.progress'; at: number; incidentId: string; phase: 'canary' | 'smoke' | 'promoted' | 'rolled_back' | 'failed'; version: string; ok: boolean; url?: string; detail?: string; provider: string }
  | { type: 'eval.scored'; at: number; incidentId: string; score: number; rubric: EvalRubric; verdict: string; model: string; traceUrl?: string }
  | { type: 'memory.learned'; at: number; incidentId: string; bugId: string; fixId: string; edges: number }
  | { type: 'incident.closed'; at: number; incidentId: string; outcome: IncidentOutcome; durationMs: number; score?: number; summary?: string }
  | { type: 'patrol.tick'; at: number; flows: { flowId: string; ok: boolean }[]; nextInSec: number }
  | { type: 'store.version'; at: number; version: string; url: string; note?: string }
  | { type: 'log'; at: number; incidentId?: string; level: 'info' | 'warn' | 'error'; message: string; sponsor?: Sponsor };

export type IncidentEventType = IncidentEvent['type'];

/** Messages pushed by the server over the WebSocket at /ws. */
export type ServerMessage =
  | { kind: 'hello'; modes: ProviderModes; liveUrl: string; serverTime: number; recent: IncidentEvent[] }
  | { kind: 'event'; event: IncidentEvent };

export type EventListener = (event: IncidentEvent) => void;

/** In-process pub/sub with a bounded history (used for replay + incident detail). */
export class EventBus {
  private listeners = new Set<EventListener>();
  private history: IncidentEvent[] = [];

  constructor(private readonly maxHistory = 5000) {}

  emit(event: IncidentEvent): void {
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error('[bus] listener failed', err);
      }
    }
  }

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recent(limit = 200): IncidentEvent[] {
    return this.history.slice(-limit);
  }

  forIncident(incidentId: string): IncidentEvent[] {
    return this.history.filter((e) => 'incidentId' in e && e.incidentId === incidentId);
  }
}
