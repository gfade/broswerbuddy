// Boot, the live connection, REST snapshots, and the switch between live and demo mode.
import type { IncidentEvent, ServerMessage } from '@healops/shared/types';
import { api } from './api';
import { onEvent, publish } from './bus';
import { DEMO_MODES, DEMO_STORE_URL, startDemo, stopDemo } from './demo';
import { applyEvent, model, resetModel } from './model';
import { emit, ui } from './state';
import { debounce, errMsg } from './util';
import { connectWs } from './ws';

let conn: { close(): void } | undefined;

async function load<T>(fetcher: () => Promise<T>, apply: (value: T) => void): Promise<void> {
  try {
    apply(await fetcher());
    if (!ui.apiOk) ui.apiOk = true;
  } catch (err) {
    if (ui.apiOk) ui.apiOk = false;
    console.warn('[healops] request failed:', errMsg(err));
  }
  emit();
}

export function refreshFlows(): Promise<void> {
  return load(() => api.flows(), (v) => {
    ui.flows = v;
  });
}

export function refreshIncidents(): Promise<void> {
  return load(() => api.incidents(), (v) => {
    ui.incidents = [...v].sort((a, b) => b.openedAt - a.openedAt);
  });
}

export function refreshStats(): Promise<void> {
  return load(() => api.stats(), (s) => {
    ui.stats = s;
    if (!model.liveVersion) model.liveVersion = s.liveVersion;
  });
}

export function refreshSeeds(): Promise<void> {
  return load(() => api.seeds(), (v) => {
    ui.seeds = v;
  });
}

export function refreshGraph(): Promise<void> {
  return load(() => api.memoryGraph(), (g) => {
    ui.graph = g;
  });
}

export function refreshAll(): void {
  void refreshFlows();
  void refreshIncidents();
  void refreshStats();
  void refreshSeeds();
  if (ui.route === 'memory') void refreshGraph();
}

const refreshIncidentsSoon = debounce(() => {
  void refreshIncidents();
  void refreshStats();
}, 350);
const refreshFlowsSoon = debounce(() => {
  void refreshFlows();
}, 600);
const refreshGraphSoon = debounce(() => {
  if (ui.route === 'memory') void refreshGraph();
}, 700);

/** REST refreshes triggered by the event stream (both live and demo). */
function sideEffects(e: IncidentEvent): void {
  switch (e.type) {
    case 'incident.opened':
    case 'incident.closed':
      refreshIncidentsSoon();
      break;
    case 'flow.completed':
      refreshFlowsSoon();
      break;
    case 'memory.learned':
      refreshGraphSoon();
      break;
    default:
      break;
  }
}
onEvent(sideEffects);

/** After a (re)connect the server replays recent events; if the newest incident is older than that, fetch its history. */
async function hydrateLatest(): Promise<void> {
  const latest = ui.incidents[0];
  if (!latest || model.incidents.has(latest.id)) return;
  try {
    const detail = await api.incident(latest.id);
    const events = [...detail.events].sort((a, b) => a.at - b.at);
    for (const e of events) applyEvent(e);
    emit();
  } catch (err) {
    console.warn('[healops] could not hydrate incident', errMsg(err));
  }
}

function scheduleDemoOffer(): void {
  window.setTimeout(() => {
    if (ui.mode === 'live' && ui.ws !== 'live') {
      ui.offerDemo = true;
      emit();
    }
  }, 5000);
}

export function connectLive(): void {
  conn?.close();
  ui.mode = 'live';
  ui.ws = 'connecting';
  conn = connectWs({
    onOpen() {
      // wait for the hello message, which carries the provider modes and recent events
    },
    onHello(msg: Extract<ServerMessage, { kind: 'hello' }>) {
      ui.ws = 'live';
      ui.offerDemo = false;
      ui.modes = msg.modes;
      ui.liveUrl = msg.liveUrl;
      resetModel();
      for (const e of msg.recent ?? []) applyEvent(e);
      emit();
      void hydrateLatest();
      refreshAll();
    },
    onEvent(e) {
      if (ui.mode === 'live') publish(e);
    },
    onClose() {
      if (ui.mode !== 'live') return;
      ui.ws = 'reconnecting';
      scheduleDemoOffer();
      emit();
    },
  });
}

export function startDemoMode(variant: 'auto' | 'approval' = 'auto'): void {
  conn?.close();
  conn = undefined;
  ui.mode = 'demo';
  ui.ws = 'demo';
  ui.offerDemo = false;
  ui.modes = DEMO_MODES;
  ui.liveUrl = DEMO_STORE_URL;
  ui.stageView = undefined;
  startDemo(variant);
  refreshAll();
  emit();
}

export function exitDemoMode(): void {
  stopDemo();
  ui.modes = undefined;
  ui.liveUrl = '';
  ui.stageView = undefined;
  resetModel();
  connectLive();
  refreshAll();
  emit();
}

export function boot(): void {
  const demo = new URLSearchParams(window.location.search).get('demo');
  if (demo === '1' || demo === 'approval') startDemoMode(demo === 'approval' ? 'approval' : 'auto');
  else connectLive();
  refreshAll();
  window.setInterval(() => {
    if (ui.mode === 'live') refreshAll();
  }, 15_000);
  scheduleDemoOffer();
}
