// End-to-end run with the real sponsor adapters (no HTTP server):
//   npx tsx scripts/e2e.ts [seedId]
// Injects a seeded bug into the live store, runs the flow that catches it, waits for HealOps
// to heal the incident, then re-runs the flow against the live store to prove the fix.
import type { IncidentEvent } from '@healops/shared';
import { createHealOps } from '../apps/server/src/wire.js';

const seedId = process.argv[2] ?? 'checkout-discount';
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
let thinkingChars = 0;

function line(e: IncidentEvent): string | undefined {
  switch (e.type) {
    case 'incident.opened': return `🚨 incident ${e.incidentId}: ${e.title} [${e.severity}]`;
    case 'stage.changed': return `   ${e.status === 'started' ? '▶' : e.status === 'completed' ? '✔' : e.status === 'failed' ? '✖' : '·'} ${e.stage.padEnd(9)} ${e.sponsor.padEnd(8)} ${e.detail ?? ''}`;
    case 'flow.completed': return `   ↳ flow ${e.flowId} (${e.purpose}, ${e.provider}) ${e.ok ? 'passed' : `FAILED at step ${e.failedStep}: ${e.error?.slice(0, 100)}`} in ${e.durationMs}ms`;
    case 'anchor.session': return e.liveViewUrl ? `   ↳ Anchor live view ready (${e.sessionId})` : undefined;
    case 'triage.result': return `   ↳ ${e.guard}: ${e.safe ? 'safe' : 'UNSAFE'} · ${e.severity} · ${e.category}`;
    case 'memory.match': return `   ↳ memory: ${e.matches.length ? e.matches.map((m) => `${m.similarity.toFixed(2)} ${m.signature.slice(0, 60)}`).join(' | ') : 'no similar bugs'}`;
    case 'sandbox.created': return `   ↳ sandbox ${e.sandboxId} (${e.provider})`;
    case 'sandbox.result': return `   ↳ ${e.phase}: ${e.passed ? 'passed' : 'failed'} — ${e.summary.slice(0, 120)}`;
    case 'llm.delta': thinkingChars += e.text.length; return undefined;
    case 'patch.ready': return `   ↳ patch #${e.attempt} by ${e.model} (conf ${e.confidence}): ${e.summary} [${e.files.join(', ')}] · thinking streamed: ${thinkingChars} chars`;
    case 'patch.rejected': return `   ↳ patch #${e.attempt} rejected: ${e.reason.slice(0, 140)}`;
    case 'gate.decision': return `   ↳ gate: ${e.decision} (risk ${e.risk}, pre-score ${e.preScore ?? '-'})`;
    case 'deploy.progress': return `   ↳ deploy ${e.phase} ${e.version} ${e.ok ? '✓' : '✗'} ${e.url ?? ''}`;
    case 'eval.scored': return `   ↳ judge ${e.model}: ${e.score}/100 — ${e.verdict.slice(0, 100)}`;
    case 'memory.learned': return `   ↳ learned: bug ${e.bugId} → fix ${e.fixId} (${e.edges} edges)`;
    case 'incident.closed': return `🏁 ${e.outcome.toUpperCase()} in ${(e.durationMs / 1000).toFixed(1)}s${e.score != null ? ` · score ${e.score}` : ''} ${e.summary ?? ''}`;
    case 'store.version': return `📦 store now v${e.version} ${e.note ?? ''}`;
    case 'log': return e.level === 'info' ? undefined : `   [${e.level}] ${e.message}`;
    default: return undefined;
  }
}

const runtime = await createHealOps();
runtime.bus.subscribe((e) => {
  const l = line(e);
  if (l) console.log(stamp(), l);
});
await runtime.init();
console.log('modes:', JSON.stringify(runtime.modes));
console.log('live store:', runtime.liveUrl());

const seed = runtime.seeds().find((s) => s.id === seedId);
if (!seed) throw new Error(`unknown seed ${seedId}; known: ${runtime.seeds().map((s) => s.id).join(', ')}`);
const { version } = await runtime.reseed(seedId);
console.log(stamp(), `injected bug "${seed.title}" as v${version}`);

const closed = new Promise<IncidentEvent & { type: 'incident.closed' }>((resolve) => {
  runtime.bus.subscribe((e) => {
    if (e.type === 'incident.closed') resolve(e);
  });
});
const { result, incidentId } = await runtime.runFlow(seed.flowId, 'manual');
if (!incidentId) {
  console.log(stamp(), `flow ${seed.flowId} ${result.ok ? 'PASSED (bug not detected!)' : 'failed but no incident opened'}`);
  await runtime.shutdown();
  process.exit(1);
}
const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out after 12 minutes')), 12 * 60_000));
const outcome = await Promise.race([closed, timeout]);

const after = await runtime.runFlow(seed.flowId, 'manual');
console.log(stamp(), `re-check on live store: flow ${seed.flowId} ${after.result.ok ? 'PASSES ✅' : 'still FAILS ❌'}`);
const detail = await runtime.getIncident(incidentId);
console.log(stamp(), `trace: ${detail?.traceUrl ?? detail?.traceId ?? 'n/a'} · spans recorded: ${detail?.spans.length ?? 0}`);
await runtime.shutdown();
process.exit(outcome.outcome === 'healed' && after.result.ok ? 0 : 1);
