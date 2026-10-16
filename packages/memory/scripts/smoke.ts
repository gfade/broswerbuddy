/**
 * Smoke test for @healops/memory. The embedded SurrealDB provider (persisted, closed, reopened)
 * and the in-memory provider run the same scenario.
 *
 *   npx tsx packages/memory/scripts/smoke.ts
 *
 * Data goes to <dataDir>/memory-smoke, which is removed before and after the run.
 * Exits 1 if any check fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  errorMessage,
  loadConfig,
  type GraphEdge,
  type GraphNode,
  type HealOpsConfig,
  type IncidentSummary,
  type Memory,
} from '@healops/shared';
import { createInMemoryMemory, createMemory, hashEmbed, seedHistory } from '../src/index.js';

const EMBEDDED = 'surrealdb-embedded';
const IN_MEMORY = 'in-memory';
const NEW_SIGNATURE = "TypeError: Cannot read properties of undefined (reading 'subtotal') @ js/cart.js";
const CART_FIX = 'Guard cart totals before reading them';

interface Result {
  provider: string;
  step: string;
  ok: boolean;
  detail: string;
}

interface Snapshot {
  bugs: number;
  fixes: number;
  incidents: number;
  edges: number;
  newest?: string;
  title?: string;
}

const results: Result[] = [];

async function step(provider: string, name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = (await fn()) ?? '';
    results.push({ provider, step: name, ok: true, detail });
  } catch (err) {
    results.push({ provider, step: name, ok: false, detail: errorMessage(err) });
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const embedAsync = async (text: string): Promise<number[]> => hashEmbed(text);

async function snapshot(mem: Memory): Promise<Snapshot> {
  const stats = await mem.stats();
  const graph = await mem.graph();
  const list = await mem.listIncidents(100);
  return {
    bugs: stats.bugs,
    fixes: stats.fixes,
    incidents: stats.incidents,
    edges: graph.edges.length,
    newest: list[0]?.id,
    title: list.find((i) => i.id === 'inc_smoke_1')?.title,
  };
}

async function scenario(expected: string, mem: Memory, reopen?: () => Promise<Memory>): Promise<void> {
  const p = expected;
  let bugId = '';
  let cartBugId = '';
  let fixId = '';

  await step(p, 'provider name', async () => {
    expect(mem.provider === expected, `expected ${expected}, got ${mem.provider}`);
    return mem.provider;
  });

  await step(p, 'seed history returns 3', async () => {
    const n = await seedHistory(mem, embedAsync);
    expect(n === 3, `seeded ${n}`);
    return `${n} past bugs`;
  });

  await step(p, 'seed again returns 0', async () => {
    const n = await seedHistory(mem, embedAsync);
    expect(n === 0, `seeded ${n}`);
    return `${n}`;
  });

  await step(p, 'stats after seed', async () => {
    const s = await mem.stats();
    expect(
      s.bugs === 3 && s.fixes === 3 && s.incidents === 2 && s.healed === 2 && s.memoryHits === 1,
      JSON.stringify(s),
    );
    return `bugs ${s.bugs}, fixes ${s.fixes}, incidents ${s.incidents}, healed ${s.healed}, memoryHits ${s.memoryHits}`;
  });

  await step(p, 'recordBug (new cart error)', async () => {
    const bug = await mem.recordBug({
      incidentId: 'inc_smoke_1',
      signature: NEW_SIGNATURE,
      flowId: 'checkout',
      errorMessage: "Cannot read properties of undefined (reading 'subtotal')",
      severity: 'sev2',
      embedding: hashEmbed(NEW_SIGNATURE),
    });
    expect(bug.id.startsWith('bug:'), `id ${bug.id}`);
    bugId = bug.id;
    return bug.id;
  });

  await step(p, 'similarBugs: seeded cart bug first, with its fix', async () => {
    const sims = await mem.similarBugs(hashEmbed(NEW_SIGNATURE), { excludeBugId: bugId, limit: 3 });
    const top = sims[0];
    expect(top !== undefined, 'no similar bugs');
    expect(top.bug.signature.includes("(reading 'total')"), `top is ${top.bug.signature}`);
    expect(top.similarity > 0.5, `similarity ${top.similarity}`);
    expect(
      top.fixes.some((f) => f.summary === CART_FIX),
      `fixes ${JSON.stringify(top.fixes.map((f) => f.summary))}`,
    );
    cartBugId = top.bug.id;
    return `similarity ${top.similarity.toFixed(3)}, fix "${CART_FIX}"`;
  });

  await step(p, 'recordFix + updateFix', async () => {
    const fix = await mem.recordFix({
      bugId,
      incidentId: 'inc_smoke_1',
      summary: 'Guard subtotal before reading it',
      rootCause: 'cart.totals was read before the cart hydrated',
      diff: '--- a/js/cart.js\n+++ b/js/cart.js\n@@ -1 +1 @@\n-const s = cart.totals.subtotal;\n+const s = cart.totals?.subtotal ?? 0;\n',
      files: ['js/cart.js'],
      verified: false,
      deployed: false,
    });
    expect(fix.id.startsWith('fix:') && fix.bugId === bugId, `fix ${fix.id}`);
    await mem.updateFix(fix.id, { verified: true, deployed: true, score: 95 });
    const [self] = await mem.similarBugs(hashEmbed(NEW_SIGNATURE), { limit: 1 });
    const updated = self?.fixes.find((f) => f.id === fix.id);
    expect(
      self?.bug.id === bugId && updated?.verified === true && updated.deployed === true && updated.score === 95,
      `state ${JSON.stringify(updated)}`,
    );
    fixId = fix.id;
    return fix.id;
  });

  await step(p, 'linkSimilar (twice, one edge)', async () => {
    await mem.linkSimilar(bugId, cartBugId, 0.9);
    await mem.linkSimilar(bugId, cartBugId, 0.9);
    return 'similar_to';
  });

  await step(p, 'recordEval sets the fix score', async () => {
    await mem.recordEval(fixId, {
      score: 91,
      rubric: { correctness: 1, minimality: 0.9, testCoverage: 0.6, safety: 1, memoryUse: 0.8 },
      verdict: 'Minimal guard, verified in sandbox.',
      model: 'smoke-judge',
    });
    const [self] = await mem.similarBugs(hashEmbed(NEW_SIGNATURE), { limit: 1 });
    const fix = self?.fixes.find((f) => f.id === fixId);
    expect(fix?.score === 91, `score ${fix?.score}`);
    return 'score 91';
  });

  await step(p, 'upsertIncident creates, then merges by id', async () => {
    const now = Date.now();
    const incident: IncidentSummary = {
      id: 'inc_smoke_1',
      title: 'Smoke: checkout subtotal',
      status: 'healed',
      source: 'patrol',
      flowId: 'checkout',
      severity: 'sev2',
      openedAt: now - 1000,
      closedAt: now,
      outcome: 'healed',
      score: 91,
      memoryHit: cartBugId,
      healMs: 1000,
      bugId,
      fixId,
    };
    await mem.upsertIncident(incident);
    // Partial update: fields that are not given must survive the merge.
    await mem.upsertIncident({ id: 'inc_smoke_1', outcome: 'healed' } as IncidentSummary);
    const got = (await mem.listIncidents(100)).find((i) => i.id === 'inc_smoke_1');
    expect(
      got?.title === 'Smoke: checkout subtotal' && got.status === 'healed' && got.score === 91 && got.memoryHit === cartBugId,
      JSON.stringify(got),
    );
    return `title kept, status ${got?.status}`;
  });

  await step(p, 'recordTransition', async () => {
    await mem.recordTransition('inc_smoke_1', 'recall', 'completed', { matches: 1, top: cartBugId });
    await mem.recordTransition('inc_smoke_1', 'learn', 'completed', { fixId });
    return 'recall, learn';
  });

  await step(p, 'listIncidents newest first', async () => {
    const list = await mem.listIncidents(10);
    expect(list[0]?.id === 'inc_smoke_1', `first is ${list[0]?.id}`);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].openedAt >= list[i].openedAt, 'not sorted by openedAt');
    }
    return `${list.length} listed, newest ${list[0]?.id}`;
  });

  await step(p, 'graph: node and edge types, labels, endpoints', async () => {
    const g = await mem.graph();
    const nodeTypes = new Set(g.nodes.map((n) => n.type));
    const needNodes: GraphNode['type'][] = ['bug', 'fix', 'file', 'flow', 'incident'];
    for (const t of needNodes) expect(nodeTypes.has(t), `no ${t} nodes`);
    const edgeTypes = new Set(g.edges.map((e) => e.type));
    const needEdges: GraphEdge['type'][] = ['fixed_by', 'touches', 'detected_in', 'about', 'similar_to'];
    for (const t of needEdges) expect(edgeTypes.has(t), `no ${t} edges`);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => ids.has(e.from) && ids.has(e.to)), 'an edge points at a missing node');
    expect(g.edges.filter((e) => e.type === 'similar_to').length === 1, 'similar_to should be a single edge');
    const newBug = g.nodes.find((n) => n.id === bugId);
    expect(newBug?.label.includes("(reading 'subtotal')"), `bug label ${newBug?.label}`);
    expect(
      g.edges.some((e) => e.type === 'about' && e.from === 'incident:inc_smoke_1' && e.to === bugId),
      'about edge incident -> bug missing',
    );
    return `${g.nodes.length} nodes, ${g.edges.length} edges`;
  });

  await step(p, 'stats sane', async () => {
    const s = await mem.stats();
    expect(
      s.incidents >= 3 && s.healed >= 3 && s.bugs >= 4 && s.fixes >= 4 && s.memoryHits >= 1,
      JSON.stringify(s),
    );
    expect(typeof s.avgHealMs === 'number' && typeof s.avgScore === 'number', 'averages missing');
    return `incidents ${s.incidents}, healed ${s.healed}, bugs ${s.bugs}, fixes ${s.fixes}, memoryHits ${s.memoryHits}, avgHealMs ${s.avgHealMs}, avgScore ${s.avgScore}`;
  });

  await step(p, 'rejects a wrong-size embedding', async () => {
    let rejected = false;
    try {
      await mem.recordBug({ incidentId: 'inc_x', signature: 'x', errorMessage: 'x', severity: 'sev3', embedding: [1, 2, 3] });
    } catch {
      rejected = true;
    }
    expect(rejected, 'recordBug accepted a 3-d embedding');
    return 'rejected';
  });

  await step(p, 'unknown bug / fix are rejected', async () => {
    const errors: string[] = [];
    await mem.recordFix({ bugId: 'bug:does-not-exist', incidentId: 'x', summary: 's', rootCause: 'r', diff: '', files: [], verified: false, deployed: false }).catch((e: unknown) => errors.push(errorMessage(e)));
    await mem.updateFix('fix:does-not-exist', { verified: true }).catch((e: unknown) => errors.push(errorMessage(e)));
    expect(errors.length === 2, `errors: ${errors.length}`);
    return errors[0];
  });

  await step(p, 'onChange reports incident writes', async () => {
    if (!mem.onChange) return 'not offered by this provider (no LIVE)';
    const events: Array<{ table: string; action: string; id: string }> = [];
    const stop = await mem.onChange((change) => events.push(change));
    await mem.upsertIncident({
      id: 'inc_smoke_live',
      title: 'Live check',
      status: 'open',
      source: 'manual',
      severity: 'sev3',
      openedAt: Date.now(),
    });
    const deadline = Date.now() + 5000;
    while (!events.some((e) => e.id === 'incident:inc_smoke_live') && Date.now() < deadline) {
      await sleep(50);
    }
    stop();
    expect(events.some((e) => e.table === 'incident' && e.id === 'incident:inc_smoke_live'), `events ${JSON.stringify(events)}`);
    return `${events.length} event(s), first ${events[0]?.action} ${events[0]?.id}`;
  });

  if (reopen) {
    await step(p, 'close, reopen: data persisted', async () => {
      let before: Snapshot;
      try {
        before = await snapshot(mem);
      } finally {
        await mem.close();
      }
      const again = await reopen();
      try {
        expect(again.provider === expected, `reopened as ${again.provider}`);
        const after = await snapshot(again);
        expect(JSON.stringify(before) === JSON.stringify(after), `before ${JSON.stringify(before)} / after ${JSON.stringify(after)}`);
        return `${after.bugs} bugs, ${after.fixes} fixes, ${after.edges} edges, newest ${after.newest}`;
      } finally {
        await again.close();
      }
    });
  } else {
    await step(p, 'close', async () => {
      await mem.close();
    });
  }
}

async function main(): Promise<number> {
  const base = loadConfig();
  const dataDir = path.join(base.dataDir, 'memory-smoke');
  // Embedded run: ignore any SURREAL_URL in .env so this always exercises the local engine.
  const cfg: HealOpsConfig = {
    ...base,
    dataDir,
    surreal: { ...base.surreal, url: undefined, token: undefined, username: undefined, password: undefined },
  };
  const removeData = (): void => fs.rmSync(dataDir, { recursive: true, force: true });

  removeData();
  fs.mkdirSync(dataDir, { recursive: true });

  await step('util', 'hashEmbed: 256-d, unit length, deterministic', async () => {
    const v = hashEmbed(NEW_SIGNATURE);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(v.length === 256 && Math.abs(norm - 1) < 1e-9, `length ${v.length}, norm ${norm}`);
    expect(JSON.stringify(v) === JSON.stringify(hashEmbed(NEW_SIGNATURE)), 'not deterministic');
    return `norm ${norm.toFixed(6)}`;
  });

  await scenario(EMBEDDED, await createMemory(cfg), () => createMemory(cfg));
  await scenario(IN_MEMORY, await createInMemoryMemory());

  let cleanup = 'removed';
  try {
    removeData();
  } catch (err) {
    cleanup = `could not remove (${errorMessage(err)})`;
  }
  results.push({ provider: 'all', step: 'remove memory-smoke', ok: cleanup === 'removed', detail: cleanup });

  return printResults();
}

function printResults(): number {
  const rows = results.map((r) => [r.provider, r.step, r.ok ? 'PASS' : 'FAIL', r.detail.replace(/\s+/g, ' ').slice(0, 120)]);
  const header = ['provider', 'check', 'result', 'detail'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log('');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  return failed;
}

main()
  .then((failed) => process.exit(failed > 0 ? 1 : 0))
  .catch((err: unknown) => {
    console.error('smoke test crashed:', errorMessage(err));
    process.exit(1);
  });
