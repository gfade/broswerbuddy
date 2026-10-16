import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type HealOpsRuntime, type ProviderModes } from '@healops/shared';
import { createFakeRuntime } from './fake-runtime.js';
import { startServer, type RunningServer } from './server.js';

interface ModeRow {
  capability: string;
  provider: string;
  status: 'LIVE' | 'LOCAL FALLBACK';
  backend: string;
}

/** One row per capability: LIVE when the sponsor service is in use, LOCAL FALLBACK otherwise. */
export function providerRows(modes: ProviderModes): ModeRow[] {
  const row = (capability: string, provider: string, live: boolean, backend: string): ModeRow => ({
    capability,
    provider,
    status: live ? 'LIVE' : 'LOCAL FALLBACK',
    backend,
  });
  return [
    row('browser', modes.browser, modes.browser === 'anchor', 'Anchor'),
    row('sandbox', modes.sandbox, modes.sandbox === 'daytona', 'Daytona'),
    row('memory', modes.memory, modes.memory === 'surrealdb-cloud', 'SurrealDB Cloud'),
    row('llm', modes.llm, modes.llm !== 'offline', modes.llm === 'anthropic' ? 'Anthropic API' : 'AWS Bedrock'),
    row('guardrails', modes.guardrails, modes.guardrails === 'bedrock-guardrails', 'Bedrock Guardrails'),
    row('telemetry', modes.telemetry, modes.telemetry === 'arize', 'Arize'),
    row('deploy', modes.deploy, modes.deploy === 'aws-s3', 'AWS S3'),
  ];
}

async function loadRuntime(fake: boolean): Promise<HealOpsRuntime> {
  if (fake) return createFakeRuntime();
  const { createHealOps } = await import('./wire.js');
  return createHealOps();
}

function printBanner(opts: {
  server: RunningServer;
  runtime: HealOpsRuntime;
  fake: boolean;
  dashboardBuilt: boolean;
  patrolSec?: number;
  patrolOff: boolean;
}): void {
  const { server, runtime, fake, dashboardBuilt, patrolSec, patrolOff } = opts;
  const wsUrl = server.url.replace(/^http/, 'ws') + '/ws';
  const dashboard = dashboardBuilt
    ? `${server.url}/`
    : `${server.url}/  (not built: run npm run build, or use the Vite dev server at http://localhost:5173)`;
  const patrol = patrolOff ? 'off (HEALOPS_NO_PATROL=1)' : `every ${patrolSec}s`;

  console.log('');
  console.log('HealOps server');
  console.log(`  API         ${server.url}/api`);
  console.log(`  WebSocket   ${wsUrl}`);
  console.log(`  Dashboard   ${dashboard}`);
  console.log(`  Widget      ${server.url}/widget/healops.js`);
  console.log(`  Live store  ${runtime.liveUrl() || '(none yet)'}`);
  console.log(`  Runtime     ${fake ? 'FAKE (in-memory, no sponsors contacted)' : 'real (wire.ts)'}`);
  console.log(`  Patrol      ${patrol}`);
  console.log('');
  console.log('Provider modes');
  console.table(providerRows(runtime.modes));
  const m = runtime.modes.models;
  console.log('Claude models');
  console.table([
    { role: 'patch', model: m.patch },
    { role: 'judge', model: m.judge },
    { role: 'triage', model: m.triage },
    { role: 'embed', model: m.embed },
  ]);
  console.log('Press Ctrl+C to stop.');
}

function installShutdown(server: RunningServer, runtime: HealOpsRuntime): void {
  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[server] ${signal} received, shutting down`);
    // Hard stop if something hangs; unref so it never keeps a finished process alive.
    setTimeout(() => process.exit(1), 8000).unref();
    await server.close().catch((err) => console.error('[server] close failed:', err));
    await runtime.shutdown().catch((err) => console.error('[server] runtime shutdown failed:', err));
    process.exit(0);
  };
  // `once`: a second Ctrl+C during shutdown falls back to the default (immediate) exit.
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const fake = process.env.HEALOPS_FAKE === '1';
  const runtime = await loadRuntime(fake);
  await runtime.init();

  const dashboardDir = path.join(cfg.root, 'apps', 'dashboard', 'dist');
  const widgetFile = path.join(cfg.root, 'apps', 'widget', 'dist', 'healops.js');
  const server = await startServer(runtime, {
    port: cfg.serverPort,
    dashboardDir,
    widgetFile,
    artifactsDir: cfg.artifactsDir,
  });

  const patrolOff = process.env.HEALOPS_NO_PATROL === '1';
  if (!patrolOff) runtime.startPatrol();

  printBanner({
    server,
    runtime,
    fake,
    dashboardBuilt: fs.existsSync(path.join(dashboardDir, 'index.html')),
    patrolSec: cfg.patrolIntervalSec,
    patrolOff,
  });
  installShutdown(server, runtime);
}

// Keep the server alive through a stray async failure; log it so it is still visible.
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));

main().catch((err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] port is already in use. Stop the other process or set HEALOPS_SERVER_PORT.`);
  } else {
    console.error('[server] failed to start:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
