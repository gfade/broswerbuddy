import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type HealOpsConfig } from '@healops/shared';
import { createMemory, hashEmbed, seedHistory } from '../src/index.js';

const base = loadConfig();
const dir = path.join(base.dataDir, 'memory-verify');
fs.rmSync(dir, { recursive: true, force: true });

const cfg: HealOpsConfig = { ...base, dataDir: dir, surreal: { ...base.surreal, url: undefined } };
const mem = await createMemory(cfg);
await seedHistory(mem, async (t) => hashEmbed(t));
const graph = await mem.graph();
console.log('onChange present:', typeof mem.onChange === 'function', 'provider:', mem.provider);
const incidents = await mem.listIncidents(5);
console.log('incidents:', incidents.map((i) => `${i.id} | ${i.status} | ${i.title} | memoryHit=${i.memoryHit ?? '-'} | bugId=${i.bugId}`).join('\n  '));
console.log('--- sample node labels:', graph.nodes.map((n) => `${n.type}:${n.label}`).join(' || '));
const fix = (await mem.similarBugs(hashEmbed("TypeError: Cannot read properties of undefined (reading 'total') @ js/cart.js"), { limit: 1 }))[0]?.fixes[0];
console.log('--- cart fix diff:\n' + (fix?.diff ?? '(none)'));
await mem.close();

// Schema as stored (proves idempotent definitions and the HNSW index).
const { Surreal } = await import('surrealdb');
const { createNodeEngines } = await import('@surrealdb/node');
const db = new Surreal({ engines: createNodeEngines() });
await db.connect(`surrealkv:${path.join(dir, 'surreal').replace(/\\/g, '/')}`);
await db.use({ namespace: cfg.surreal.namespace, database: cfg.surreal.database });
const [info] = await db.query('INFO FOR DB').collect<unknown[]>();
const [bugInfo] = await db.query('INFO FOR TABLE bug').collect<unknown[]>();
const [edgeInfo] = await db.query('INFO FOR TABLE fixed_by').collect<unknown[]>();
console.log('--- INFO FOR DB:', JSON.stringify(info).slice(0, 900));
console.log('--- INFO FOR TABLE bug:', JSON.stringify(bugInfo).slice(0, 700));
console.log('--- INFO FOR TABLE fixed_by:', JSON.stringify(edgeInfo).slice(0, 300));
await db.close();

// Cloud fallback against an unreachable endpoint: must not hang, must fall back.
for (const url of ['ws://127.0.0.1:9', 'http://127.0.0.1:9']) {
  const started = Date.now();
  const cloudCfg: HealOpsConfig = { ...base, dataDir: dir, surreal: { ...base.surreal, url, token: undefined, username: 'u', password: 'p' } };
  const fallback = await createMemory(cloudCfg);
  console.log(`--- cloud ${url} -> provider ${fallback.provider} after ${Date.now() - started} ms`);
  await fallback.close();
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('verify done, removed', dir);
