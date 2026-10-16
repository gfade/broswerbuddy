// Scripted incident for demo mode, plus fixtures for every REST endpoint, so the whole dashboard runs
// without a backend. Scripted events go through publish(), the same path as live events.
import type {
  DashboardStats, EvalResult, EvalRubric, FlowInfo, FlowRunResult, GraphEdge, GraphNode, IncidentDetail,
  IncidentEvent, IncidentSummary, MemoryGraph, ProviderModes, RecordedSpan, Stage,
} from '@healops/shared/types';
import { publish } from './bus';
import { STAGES, STAGE_SPONSOR } from './constants';
import { type IncidentView, model, resetModel } from './model';
import { type Seed, ui } from './state';
import { sleep } from './util';

export const DEMO_STORE_URL = 'https://lol-store.example';
const ARIZE_URL = 'https://app.arize.com';
const INC = '212';
const SANDBOX = 'sb_9f2c';
const TRACE_ID = '7f3ae91c0b24d5e6a1f0c9d8e7b6a5f4';
const NEW_VERSION = 'v1.4.3';
const MODEL_PATCH = 'Claude Sonnet 4.5';
const MODEL_JUDGE = 'Claude Haiku 4.5';
const CHECKOUT_TITLE = 'Checkout fails: cart.total is undefined';
const ERROR_MSG = "TypeError: Cannot read properties of undefined (reading 'total')";

export const DEMO_MODES: ProviderModes = {
  browser: 'anchor',
  sandbox: 'daytona',
  memory: 'surrealdb-cloud',
  llm: 'bedrock',
  guardrails: 'bedrock-guardrails',
  telemetry: 'arize',
  deploy: 'aws-s3',
  models: { patch: MODEL_PATCH, judge: MODEL_JUDGE, triage: MODEL_JUDGE, embed: 'Titan Embeddings v2' },
};

export const DEMO_SEEDS: Seed[] = [
  { id: 'cart-undefined', title: 'Cart total undefined after discount', flowId: 'checkout', description: 'Breaks checkout when the discount is applied before the cart loads.' },
  { id: 'overlay-blocks-pay', title: 'Overlay blocks Pay on iOS', flowId: 'checkout', description: 'A promo banner covers the Pay button on small screens.' },
  { id: 'stale-search', title: 'Search returns stale results', flowId: 'search', description: 'The search index is not invalidated after a catalogue update.' },
];

const THINKING =
  'Anchor failed at step 4: clicking Pay now does not navigate. The same flow failed three times in a row, so this is not flaky. ' +
  'The stack trace points at cart.total in checkout.ts line 42. Memory has a close match: bug 118 (similarity 0.87) was a null cart ' +
  'when a discount was applied before the cart loaded, and it was fixed with a guard and a skeleton. The sandbox reproduced the same ' +
  'TypeError. The plan: guard against an undefined cart, default the total to zero, keep the change to two lines, and re-run the checkout spec.';

const ANSWER =
  'Patch ready: return a skeleton while the cart loads and default the total to zero. Two lines added, one changed. Re-running the checkout suite now.';

const PATCH_DIFF = [
  '--- a/checkout.ts',
  '+++ b/checkout.ts',
  '@@ -40,5 +40,6 @@',
  '   const cart = useCart();',
  '-  const total = cart.total * (1 - discount);',
  '+  if (!cart) return <CheckoutSkeleton />;',
  '+  const total = (cart.total ?? 0) * (1 - discount);',
  '   return <Pay total={total} />;',
].join('\n');

const REASONS_AUTO = [
  'payment path not touched',
  'diff is +2 −1 in one file',
  'input and output guard clean',
  'canary plan 5% → 100% with auto-rollback',
];
const REASONS_APPROVAL = [
  'patch touches the payment path',
  'diff is +2 −1 in one file',
  'input and output guard clean',
  'canary plan 5% → 100% with auto-rollback',
];
const RUBRIC: EvalRubric = { correctness: 0.94, minimality: 0.91, testCoverage: 0.88, safety: 1, memoryUse: 0.9 };

type WithoutAt<T> = T extends unknown ? Omit<T, 'at'> : never;
type Ev = WithoutAt<IncidentEvent>;
type Entry = [number, Ev | ((now: number) => Ev) | 'approval'];

const stage = (t: number, s: Stage, status: 'started' | 'completed' | 'failed' | 'skipped', detail?: string): Entry =>
  [t, { type: 'stage.changed', incidentId: INC, stage: s, sponsor: STAGE_SPONSOR[s], status, detail }];

const step = (t: number, index: number, name: string, ok: boolean, durationMs: number, error?: string): Entry =>
  [t, { type: 'anchor.step', incidentId: INC, flowId: 'checkout', step: { index, name, ok, durationMs, error } }];

const sbLog = (t: number, line: string): Entry => [t, { type: 'sandbox.log', incidentId: INC, sandboxId: SANDBOX, line }];

const logLine = (t: number, level: 'info' | 'warn' | 'error', message: string): Entry =>
  [t, { type: 'log', incidentId: INC, level, message, sponsor: 'anchor' }];

/** Split streamed text into small deltas, the way the model streams them. */
function streamChunks(text: string, from: number, to: number, kind: 'thinking' | 'text'): Entry[] {
  const words = text.match(/\S+\s*/g) ?? [text];
  const groups: string[] = [];
  for (let i = 0; i < words.length; i += 3) groups.push(words.slice(i, i + 3).join(''));
  const gap = (to - from) / Math.max(1, groups.length);
  return groups.map((g, i): Entry => [Math.round(from + i * gap), { type: 'llm.delta', incidentId: INC, kind, text: g, model: MODEL_PATCH }]);
}

function buildScript(variant: 'auto' | 'approval'): Entry[] {
  const gate: Entry[] =
    variant === 'approval'
      ? [
          [33200, { type: 'gate.decision', incidentId: INC, risk: 42, decision: 'needs_approval', reasons: REASONS_APPROVAL, preScore: 0.91 }],
          [33250, 'approval'],
        ]
      : [[33200, { type: 'gate.decision', incidentId: INC, risk: 31, decision: 'auto', reasons: REASONS_AUTO, preScore: 0.91 }]];

  return [
    [0, { type: 'incident.opened', incidentId: INC, title: CHECKOUT_TITLE, source: 'patrol', flowId: 'checkout', error: ERROR_MSG, severity: 'sev2', traceId: TRACE_ID }],
    stage(0, 'detect', 'started'),
    [0, { type: 'flow.started', incidentId: INC, flowId: 'checkout', baseUrl: DEMO_STORE_URL, purpose: 'patrol' }],
    [300, { type: 'anchor.session', incidentId: INC, flowId: 'checkout', provider: 'anchor', sessionId: 'as_71c' }],
    step(900, 0, 'goto /product/neon', true, 800),
    step(1200, 1, 'click "Add to cart"', true, 300),
    step(1600, 2, 'type discount "LOL20"', true, 400),
    step(6600, 3, 'click "Pay now": no navigation', false, 5000, 'no navigation to /order/confirmed after 5.0s'),
    logLine(6650, 'error', `console.error ${ERROR_MSG} at Checkout (checkout.ts:42:19)`),
    [6800, { type: 'flow.completed', incidentId: INC, flowId: 'checkout', ok: false, provider: 'anchor', durationMs: 6800, failedStep: 3, error: ERROR_MSG, purpose: 'patrol' }],
    stage(6900, 'detect', 'completed', 'failed at step 4 of 5'),
    stage(7000, 'triage', 'started'),
    [7000, { type: 'triage.result', incidentId: INC, safe: true, guard: 'bedrock-guardrails', severity: 'sev2', category: 'checkout · null reference', summary: 'Checkout crashes when a discount is applied before the cart finishes loading.' }],
    stage(7800, 'triage', 'completed'),
    stage(7900, 'recall', 'started'),
    [8200, {
      type: 'memory.match',
      incidentId: INC,
      bugId: INC,
      matches: [
        { bugId: '118', similarity: 0.87, signature: "TypeError: Cannot read properties of undefined (reading 'total') @ checkout.ts", fixSummary: 'null guard + skeleton while the cart loads', score: 4.8 },
        { bugId: '131', similarity: 0.62, signature: 'cart badge stale after discount', fixSummary: 'invalidate the cart query after apply', score: 4.6 },
      ],
    }],
    stage(8900, 'recall', 'completed'),
    stage(9000, 'reproduce', 'started'),
    [9100, { type: 'sandbox.created', incidentId: INC, sandboxId: SANDBOX, provider: 'daytona' }],
    sbLog(9300, '$ git clone lol-store@a41c9e app'),
    sbLog(10100, "Cloning into 'app'… done (0.8s)"),
    sbLog(10900, '$ npm ci'),
    sbLog(12100, '✓ 812 packages installed (6.1s)'),
    sbLog(12600, '$ npx playwright test flows/checkout.spec.ts'),
    sbLog(13200, 'Running 1 test using 1 worker'),
    sbLog(15800, '✘ checkout › discount then pay (2.3s)'),
    sbLog(16000, `    ${ERROR_MSG}`),
    sbLog(16200, '        at Checkout (checkout.ts:42:19)'),
    sbLog(16600, '1 failed · trace.zip saved'),
    [20000, { type: 'sandbox.result', incidentId: INC, sandboxId: SANDBOX, phase: 'reproduce', passed: false, summary: 'checkout › discount then pay fails with the production TypeError at checkout.ts:42', durationMs: 11400 }],
    stage(20100, 'reproduce', 'completed', 'reproduced'),
    stage(20200, 'patch', 'started'),
    ...streamChunks(THINKING, 20300, 28800, 'thinking'),
    ...streamChunks(ANSWER, 28900, 29000, 'text'),
    [29000, { type: 'patch.ready', incidentId: INC, attempt: 1, summary: 'Guard the cart before reading .total', rootCause: 'cart is undefined when the discount is applied before the cart loads', reasoning: ['Stack trace points at cart.total in checkout.ts:42', 'Memory: bug 118 had the same shape and was fixed with a guard + skeleton', 'Default the total to zero so the arithmetic cannot throw'], confidence: 0.91, diff: PATCH_DIFF, files: ['checkout.ts'], model: MODEL_PATCH, provider: 'bedrock' }],
    stage(29100, 'patch', 'completed'),
    stage(29200, 'verify', 'started'),
    sbLog(29400, '$ npx playwright test flows/checkout.spec.ts'),
    sbLog(29800, 'Running 42 tests using 4 workers'),
    sbLog(31000, '✓ checkout › discount then pay (1.9s)'),
    sbLog(31600, '✓ checkout › guest checkout (1.4s) · 40 more passing'),
    sbLog(32400, '42 passed (3.4s)'),
    [32800, { type: 'sandbox.result', incidentId: INC, sandboxId: SANDBOX, phase: 'verify', passed: true, summary: '42/42 green on the patched build', durationMs: 3400 }],
    stage(32900, 'verify', 'completed', '42/42 green'),
    stage(33000, 'gate', 'started'),
    ...gate,
    stage(33300, 'gate', 'completed', variant === 'approval' ? 'approved by a reviewer' : 'auto-approved by policy'),
    stage(33400, 'deploy', 'started'),
    [33600, { type: 'deploy.progress', incidentId: INC, phase: 'canary', version: NEW_VERSION, ok: true, url: 'https://canary.lol-store.example', detail: '5% of traffic · healthy for 60s', provider: 'aws-s3' }],
    [35000, { type: 'deploy.progress', incidentId: INC, phase: 'smoke', version: NEW_VERSION, ok: true, detail: 'Anchor smoke on canary · 5/5 passed', provider: 'aws-s3' }],
    [36000, { type: 'deploy.progress', incidentId: INC, phase: 'promoted', version: NEW_VERSION, ok: true, url: DEMO_STORE_URL, detail: '100% · 3 zones healthy', provider: 'aws-s3' }],
    [36100, { type: 'store.version', version: NEW_VERSION, url: DEMO_STORE_URL, note: 'checkout discount fix' }],
    stage(36200, 'deploy', 'completed'),
    stage(36300, 'judge', 'started'),
    [36600, { type: 'eval.scored', incidentId: INC, score: 93, rubric: RUBRIC, verdict: 'Excellent: ship it', model: MODEL_JUDGE, traceUrl: ARIZE_URL }],
    stage(36700, 'judge', 'completed'),
    stage(36800, 'learn', 'started'),
    [37200, { type: 'memory.learned', incidentId: INC, bugId: INC, fixId: 'f_241', edges: 5 }],
    stage(37400, 'learn', 'completed'),
    [37500, (now: number): Ev => ({
      type: 'incident.closed',
      incidentId: INC,
      outcome: 'healed',
      durationMs: now - (model.incidents.get(INC)?.openedAt ?? now),
      score: 93,
      summary: 'Guarded cart.total when the discount runs before the cart loads. 42/42 green on the patched build; canary promoted to 100%; memory updated.',
    })],
  ];
}

// ---- runner ------------------------------------------------------------------

let runToken = 0;
let running = false;
let variant: 'auto' | 'approval' = 'auto';
let approvalWaiter: ((approved: boolean) => void) | undefined;
let demoLog: IncidentEvent[] = [];
const demoCounts = { opened: 0, healed: 0 };
let demoVersion = 'v1.4.2';
let demoPatrolling = true;
let demoGraph: MemoryGraph = buildGraph();

export function demoRunning(): boolean {
  return running;
}

export function startDemo(v: 'auto' | 'approval'): void {
  stopDemo();
  variant = v;
  resetModel();
  demoLog = [];
  demoCounts.opened = 0;
  demoCounts.healed = 0;
  demoGraph = buildGraph();
  running = true;
  void play(runToken, buildScript(v));
}

export function stopDemo(): void {
  runToken++;
  running = false;
  const waiter = approvalWaiter;
  approvalWaiter = undefined;
  waiter?.(false);
}

/** Answer the scripted approval gate (demo of the human-in-the-loop path). */
export function resolveDemoApproval(approved: boolean): boolean {
  const waiter = approvalWaiter;
  if (!waiter) return false;
  approvalWaiter = undefined;
  waiter(approved);
  return true;
}

function emitDemo(partial: Ev): void {
  const event = { ...partial, at: Date.now() } as IncidentEvent;
  demoLog.push(event);
  if (event.type === 'incident.opened') demoCounts.opened++;
  if (event.type === 'incident.closed' && event.outcome === 'healed') demoCounts.healed++;
  if (event.type === 'store.version') demoVersion = event.version;
  if (event.type === 'memory.learned') growGraph(event.bugId, event.fixId);
  publish(event);
}

async function play(token: number, entries: Entry[]): Promise<void> {
  let prev = 0;
  for (const [t, item] of entries) {
    const gap = Math.max(0, t - prev);
    prev = t;
    if (gap > 0) await sleep(gap / ui.demoSpeed);
    if (token !== runToken) return;
    if (item === 'approval') {
      const approved = await new Promise<boolean>((resolve) => {
        approvalWaiter = resolve;
      });
      if (token !== runToken) return;
      emitDemo({ type: 'approval.resolved', incidentId: INC, approved });
      if (!approved) {
        emitDemo({
          type: 'incident.closed',
          incidentId: INC,
          outcome: 'rejected',
          durationMs: Date.now() - (model.incidents.get(INC)?.openedAt ?? Date.now()),
          summary: 'Rejected by a reviewer. The patch was not deployed.',
        });
        running = false;
        return;
      }
      continue;
    }
    emitDemo(typeof item === 'function' ? item(Date.now()) : item);
  }
  if (token === runToken) running = false;
}

// ---- fixtures ----------------------------------------------------------------

const KIND: Record<Stage, RecordedSpan['kind']> = {
  detect: 'TOOL', triage: 'GUARDRAIL', recall: 'RETRIEVER', reproduce: 'TOOL', patch: 'LLM',
  verify: 'TOOL', gate: 'EVALUATOR', deploy: 'TOOL', judge: 'EVALUATOR', learn: 'TOOL',
};

const WEIGHTS: Record<Stage, number> = {
  detect: 0.18, triage: 0.04, recall: 0.04, reproduce: 0.22, patch: 0.2,
  verify: 0.1, gate: 0.02, deploy: 0.12, judge: 0.05, learn: 0.03,
};

function buildGraph(): MemoryGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const node = (type: GraphNode['type'], id: string, label: string, data?: Record<string, unknown>): void => {
    nodes.push({ id, type, label, data });
  };
  const edge = (from: string, to: string, type: GraphEdge['type'], weight?: number): void => {
    edges.push({ from, to, type, weight });
  };

  for (const f of ['checkout.ts', 'cart.ts', 'nav.tsx', 'auth.ts', 'search.ts']) node('file', `file:${f}`, f);
  for (const f of ['checkout', 'signup', 'login', 'search']) node('flow', `flow:${f}`, f);

  node('bug', 'bug:118', 'cart undefined when discount applied early', { signature: ERROR_MSG });
  node('bug', 'bug:131', 'cart badge stale after discount');
  node('bug', 'bug:97', 'overlay blocks Pay on iOS');
  node('bug', 'bug:140', 'login redirect loop on Safari');
  node('bug', 'bug:160', 'migration 0042 slows checkout query');

  node('fix', 'fix:f_88', 'null guard + skeleton', { score: 4.8 });
  node('fix', 'fix:f_131', 'invalidate cart query', { score: 4.6 });
  node('fix', 'fix:f_97', 'z-index on the Pay button', { score: 4.7 });
  node('fix', 'fix:f_140', 'redirect allowlist', { score: 4.5 });
  const extra = ['guard before total', 'nullish default on totals', 'skeleton while cart loads', 'discount after load', 'Pay disabled while loading', 'retry on cart fetch'];
  extra.forEach((label, i) => node('fix', `fix:f_${60 + i}`, label, { score: 4.2 + i / 10 }));

  node('incident', 'incident:211', 'Incident #211', { traceUrl: ARIZE_URL });
  node('incident', 'incident:206', 'Incident #206', { traceUrl: ARIZE_URL });
  node('incident', 'incident:205', 'Incident #205', { traceUrl: ARIZE_URL });

  edge('bug:118', 'fix:f_88', 'fixed_by');
  edge('bug:131', 'fix:f_131', 'fixed_by');
  edge('bug:97', 'fix:f_97', 'fixed_by');
  edge('bug:140', 'fix:f_140', 'fixed_by');
  edge('bug:118', 'bug:131', 'similar_to', 0.62);
  edge('bug:118', 'flow:checkout', 'detected_in');
  edge('bug:131', 'flow:checkout', 'detected_in');
  edge('bug:97', 'flow:checkout', 'detected_in');
  edge('bug:140', 'flow:login', 'detected_in');
  edge('bug:160', 'flow:checkout', 'detected_in');
  edge('fix:f_88', 'file:checkout.ts', 'touches');
  edge('fix:f_131', 'file:cart.ts', 'touches');
  edge('fix:f_97', 'file:nav.tsx', 'touches');
  edge('fix:f_140', 'file:auth.ts', 'touches');
  for (let i = 0; i < extra.length; i++) edge(`fix:f_${60 + i}`, 'file:checkout.ts', 'touches');
  edge('incident:211', 'bug:97', 'about');
  edge('incident:206', 'bug:140', 'about');
  edge('incident:205', 'bug:131', 'about');

  return { nodes, edges };
}

/** Adds the bug and fix the agent just learned to the demo graph (the live SurrealDB feed, simulated). */
function growGraph(bugId: string, fixId: string): void {
  const addNode = (n: GraphNode): void => {
    if (!demoGraph.nodes.some((x) => x.id === n.id)) demoGraph.nodes.push(n);
  };
  const addEdge = (e: GraphEdge): void => {
    if (!demoGraph.edges.some((x) => x.from === e.from && x.to === e.to && x.type === e.type)) demoGraph.edges.push(e);
  };
  addNode({ id: `bug:${bugId}`, type: 'bug', label: 'cart total undefined on discount (new)', data: { signature: ERROR_MSG } });
  addNode({ id: `fix:${fixId}`, type: 'fix', label: 'guard + nullish default', data: { score: 4.9 } });
  addNode({ id: `incident:${INC}`, type: 'incident', label: `Incident #${INC}`, data: { traceUrl: ARIZE_URL } });
  addEdge({ from: `bug:${bugId}`, to: 'bug:118', type: 'similar_to', weight: 0.87 });
  addEdge({ from: `bug:${bugId}`, to: `fix:${fixId}`, type: 'fixed_by' });
  addEdge({ from: `fix:${fixId}`, to: 'file:checkout.ts', type: 'touches' });
  addEdge({ from: `bug:${bugId}`, to: 'flow:checkout', type: 'detected_in' });
  addEdge({ from: `incident:${INC}`, to: `bug:${bugId}`, type: 'about' });
}

function fixtureIncidents(): IncidentSummary[] {
  const now = Date.now();
  const h = 3_600_000;
  return [
    { id: '211', title: 'Pay button blocked by an overlay on iOS', status: 'healed', source: 'flag', flowId: 'checkout', severity: 'sev2', openedAt: now - 2 * h, closedAt: now - 2 * h + 61_000, outcome: 'healed', score: 89, memoryHit: '97', healMs: 61_000 },
    { id: '210', title: 'Search returns stale results', status: 'awaiting_approval', source: 'patrol', flowId: 'search', severity: 'sev3', openedAt: now - 3 * h, score: 71 },
    { id: '209', title: 'Signup rejects email addresses with "+"', status: 'healed', source: 'flag', flowId: 'signup', severity: 'sev3', openedAt: now - 5 * h, closedAt: now - 5 * h + 44_000, outcome: 'healed', score: 95, healMs: 44_000 },
    { id: '208', title: 'Migration 0042 slowed p95 in eu-west-1b', status: 'rolled_back', source: 'patrol', flowId: 'checkout', severity: 'sev2', openedAt: now - 9 * h, closedAt: now - 9 * h + 22_000, outcome: 'rolled_back', score: 88, memoryHit: '160', healMs: 22_000 },
    { id: '207', title: 'Suspicious instructions in flag text', status: 'quarantined', source: 'flag', severity: 'sev3', openedAt: now - 12 * h, closedAt: now - 12 * h + 2_000, outcome: 'quarantined', score: 100 },
    { id: '206', title: 'Login redirect loop on Safari', status: 'healed', source: 'patrol', flowId: 'login', severity: 'sev2', openedAt: now - 20 * h, closedAt: now - 20 * h + 52_000, outcome: 'healed', score: 90, memoryHit: '140', healMs: 52_000 },
    { id: '205', title: 'Cart badge not updating', status: 'healed', source: 'patrol', flowId: 'checkout', severity: 'sev3', openedAt: now - 26 * h, closedAt: now - 26 * h + 35_000, outcome: 'healed', score: 92, memoryHit: '131', healMs: 35_000 },
  ];
}

function summaryFromView(inc: IncidentView): IncidentSummary {
  return {
    id: inc.id,
    title: inc.title,
    status: inc.status,
    source: inc.source,
    flowId: inc.flowId,
    severity: inc.severity,
    openedAt: inc.openedAt,
    closedAt: inc.closedAt,
    outcome: inc.outcome,
    score: inc.score,
    memoryHit: inc.matches?.matches[0]?.bugId,
    healMs: inc.durationMs,
    traceId: inc.traceId,
    traceUrl: inc.traceUrl,
    error: inc.error || undefined,
  };
}

function demoIncidents(): IncidentSummary[] {
  const list = fixtureIncidents();
  const live = model.incidents.get(INC);
  if (live) list.unshift(summaryFromView(live));
  return list;
}

function demoFlows(): FlowInfo[] {
  const now = Date.now();
  const history = (failAt: number[]): boolean[] => Array.from({ length: 20 }, (_, i) => !failAt.includes(i));
  return [
    { id: 'checkout', name: 'Checkout', description: 'Add to cart, apply LOL20, pay', critical: true, lastRun: { ok: true, at: now - 41_000, durationMs: 2400, provider: 'anchor' }, history: history([17]) },
    { id: 'signup', name: 'Signup', description: 'Create an account, confirm the email', critical: true, lastRun: { ok: true, at: now - 52_000, durationMs: 1800, provider: 'anchor' }, history: history([]) },
    { id: 'login', name: 'Login', description: 'Sign in with email and password', critical: true, lastRun: { ok: true, at: now - 61_000, durationMs: 1100, provider: 'anchor' }, history: history([9]) },
    { id: 'search', name: 'Search', description: 'Search the catalogue and open a result', critical: false, lastRun: { ok: true, at: now - 12 * 60_000, durationMs: 900, provider: 'anchor' }, history: history([14, 15, 19]) },
    { id: 'password-reset', name: 'Password reset', description: 'Request a reset link and open it', critical: false, lastRun: { ok: true, at: now - 40 * 60_000, durationMs: 3200, provider: 'anchor' }, history: history([]) },
  ];
}

function demoStats(): DashboardStats {
  return {
    incidents: 53 + demoCounts.opened,
    healed: 46 + demoCounts.healed,
    bugs: 41 + demoCounts.opened,
    fixes: 46 + demoCounts.healed,
    memoryHits: 32,
    rollbacks: 2,
    avgHealMs: 41_000,
    avgScore: 91,
    liveVersion: demoVersion,
    patrolling: demoPatrolling,
    patrolIntervalSec: 300,
  };
}

/** Stage spans for the scripted incident, built from its real stage timings. */
function spansFromLog(log: IncidentEvent[]): RecordedSpan[] {
  const opened = log.find((e) => e.type === 'incident.opened');
  const closed = log.find((e) => e.type === 'incident.closed');
  const t0 = opened?.at ?? Date.now();
  const out: RecordedSpan[] = [
    { traceId: TRACE_ID, spanId: 'root', name: 'healops.incident', kind: 'AGENT', startMs: t0, endMs: closed?.at ?? Date.now(), status: 'ok', attributes: { 'healops.incident': INC } },
  ];
  const open: Partial<Record<Stage, number>> = {};
  let n = 0;
  for (const e of log) {
    if (e.type !== 'stage.changed') continue;
    if (e.status === 'started') {
      open[e.stage] = e.at;
    } else {
      const start = open[e.stage];
      if (start === undefined) continue;
      out.push({
        traceId: TRACE_ID,
        spanId: `s${n++}`,
        parentSpanId: 'root',
        name: `stage.${e.stage}`,
        kind: KIND[e.stage],
        startMs: start,
        endMs: e.at,
        status: e.status === 'failed' ? 'error' : 'ok',
        attributes: { 'healops.stage': e.stage, 'healops.sponsor': STAGE_SPONSOR[e.stage] },
      });
      delete open[e.stage];
    }
  }
  return out;
}

function synthSpans(f: IncidentSummary): RecordedSpan[] {
  const total = f.healMs ?? 30_000;
  const traceId = `fixture-${f.id}`;
  const out: RecordedSpan[] = [
    { traceId, spanId: 'root', name: 'healops.incident', kind: 'AGENT', startMs: f.openedAt, endMs: f.openedAt + total, status: 'ok', attributes: { 'healops.incident': f.id } },
  ];
  let t = f.openedAt;
  STAGES.forEach((s, i) => {
    const d = total * WEIGHTS[s];
    out.push({
      traceId,
      spanId: `s${i}`,
      parentSpanId: 'root',
      name: `stage.${s}`,
      kind: KIND[s],
      startMs: t,
      endMs: t + d,
      status: 'ok',
      attributes: { 'healops.stage': s, 'healops.sponsor': STAGE_SPONSOR[s] },
    });
    t += d;
  });
  return out;
}

function demoDetail(id: string): IncidentDetail {
  const live = model.incidents.get(id);
  if (id === INC && live) {
    const patch = live.patches[live.patches.length - 1];
    const ev = live.evalResult;
    return {
      ...summaryFromView(live),
      events: demoLog.slice(),
      spans: spansFromLog(demoLog),
      patch: patch ? { summary: patch.summary, rootCause: patch.rootCause, diff: patch.diff, confidence: patch.confidence, model: patch.model } : undefined,
      eval: ev ? { score: ev.score, rubric: ev.rubric, verdict: ev.verdict, model: ev.model } : undefined,
    };
  }
  const f = fixtureIncidents().find((x) => x.id === id);
  if (!f) throw new Error(`no incident ${id}`);
  const events: IncidentEvent[] = [
    { type: 'incident.opened', at: f.openedAt, incidentId: f.id, title: f.title, source: f.source, flowId: f.flowId, error: f.error ?? 'see incident', severity: f.severity },
  ];
  if (f.closedAt && f.outcome) {
    events.push({ type: 'incident.closed', at: f.closedAt, incidentId: f.id, outcome: f.outcome, durationMs: f.healMs ?? f.closedAt - f.openedAt, score: f.score });
  }
  const evalResult: EvalResult | undefined =
    f.score === undefined ? undefined : { score: f.score, rubric: { correctness: f.score / 100, minimality: 0.9, testCoverage: 0.85, safety: 1, memoryUse: 0.8 }, verdict: 'Recorded in fixture data', model: MODEL_JUDGE };
  return { ...f, events, spans: synthSpans(f), eval: evalResult };
}

function demoRun(flowId: string): { result: FlowRunResult; incidentId?: string } {
  const base = { flowId, baseUrl: DEMO_STORE_URL, provider: 'anchor' as const, steps: [], consoleErrors: [], pageErrors: [], startedAt: Date.now() };
  if (flowId === 'checkout') {
    startDemo(variant);
    return { result: { ...base, ok: false, failedStep: 3, error: { message: ERROR_MSG }, durationMs: 6800 }, incidentId: INC };
  }
  return { result: { ...base, ok: true, durationMs: 1900 + Math.round(Math.random() * 600) } };
}

function demoRollback(): { restoredVersion: string } {
  demoVersion = 'v1.4.2';
  publish({ type: 'store.version', at: Date.now(), version: demoVersion, url: DEMO_STORE_URL, note: 'rolled back (demo)' });
  return { restoredVersion: demoVersion };
}

/** Answers every REST call the dashboard makes, with a short delay to mimic the network. */
export async function demoRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  await sleep(80);
  const p = path.split('?')[0];
  let out: unknown;
  if (method === 'GET') {
    if (p === '/api/health') out = { ok: true, demo: true };
    else if (p === '/api/flows') out = demoFlows();
    else if (p === '/api/incidents') out = demoIncidents();
    else if (/^\/api\/incidents\/[^/]+$/.test(p)) out = demoDetail(decodeURIComponent(p.split('/')[3]));
    else if (p === '/api/seeds') out = DEMO_SEEDS;
    else if (p === '/api/memory/graph') out = JSON.parse(JSON.stringify(demoGraph));
    else if (p === '/api/stats') out = demoStats();
  } else {
    if (/^\/api\/flows\/[^/]+\/run$/.test(p)) out = demoRun(decodeURIComponent(p.split('/')[3]));
    else if (/^\/api\/incidents\/[^/]+\/approve$/.test(p)) {
      resolveDemoApproval(Boolean((body as { approved?: unknown } | undefined)?.approved));
      out = {};
    } else if (/^\/api\/incidents\/[^/]+\/takeover$/.test(p)) out = {};
    else if (p === '/api/deploy/rollback') out = demoRollback();
    else if (/^\/api\/seeds\/[^/]+\/reseed$/.test(p)) out = { version: `${demoVersion}-seeded` };
    else if (p === '/api/patrol/start' || p === '/api/patrol/stop') {
      demoPatrolling = p.endsWith('/start');
      out = {};
    }
  }
  if (out === undefined) throw new Error(`demo has no fixture for ${method} ${p}`);
  return out as T;
}
