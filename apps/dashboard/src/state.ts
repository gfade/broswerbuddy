// UI state shared by the views. Event-derived data lives in model.ts; REST snapshots live here.
import type { DashboardStats, FlowInfo, IncidentSummary, MemoryGraph, ProviderModes } from '@healops/shared/types';

export type Route = 'live' | 'incidents' | 'memory' | 'flows';
export const ROUTES: readonly Route[] = ['live', 'incidents', 'memory', 'flows'];
export const ROUTE_LABEL: Record<Route, string> = { live: 'Live', incidents: 'Incidents', memory: 'Memory', flows: 'Flows' };

export type WsState = 'connecting' | 'live' | 'reconnecting' | 'demo';
export type Tone = 'ok' | 'bad' | 'warn' | 'info';
export type StatusTab = 'all' | 'healing' | 'review' | 'resolved' | 'rolled' | 'other';

export interface Seed { id: string; title: string; flowId: string; description: string }
export interface Toast { id: number; tone: Tone; text: string }

export const ui = {
  route: 'live' as Route,
  mode: 'live' as 'live' | 'demo',
  ws: 'connecting' as WsState,
  offerDemo: false,
  apiOk: true,
  modes: undefined as ProviderModes | undefined,
  liveUrl: '',
  flows: [] as FlowInfo[],
  incidents: [] as IncidentSummary[],
  stats: undefined as DashboardStats | undefined,
  seeds: [] as Seed[],
  graph: undefined as MemoryGraph | undefined,
  /** stage index picked by the user on the Live view; undefined = follow the active stage */
  stageView: undefined as number | undefined,
  drawerId: undefined as string | undefined,
  statusTab: 'all' as StatusTab,
  query: '',
  busy: new Set<string>(),
  toasts: [] as Toast[],
  demoSpeed: 1 as 1 | 2,
};

type Listener = () => void;
const listeners = new Set<Listener>();
let frame = 0;

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Coalesce many state changes into one render per animation frame. */
export function emit(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        console.error('[healops-ui] render failed', err);
      }
    }
  });
}

let toastSeq = 1;
export function toast(tone: Tone, text: string): void {
  const id = toastSeq++;
  ui.toasts = [...ui.toasts.slice(-3), { id, tone, text }];
  emit();
  window.setTimeout(() => {
    ui.toasts = ui.toasts.filter((t) => t.id !== id);
    emit();
  }, 4400);
}

export function setBusy(key: string, on: boolean): void {
  if (on) ui.busy.add(key);
  else ui.busy.delete(key);
  emit();
}

export function isBusy(key: string): boolean {
  return ui.busy.has(key);
}
