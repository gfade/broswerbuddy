import { truncate, type ExecResult, type FlowRunResult, type Sandbox } from '@healops/shared';
import { Closed, type Heal } from './context.js';
import { stage } from './stage.js';
import { LineBatcher } from './throttle.js';

const PREVIEW_PORT = 4173;
const TEST_TIMEOUT_SEC = 120;

/** Run the sandbox test command, streaming its output to the event bus (batched). */
export async function runTests(h: Heal, sandbox: Sandbox): Promise<ExecResult> {
  const logs = new LineBatcher((line) => h.hub.emit({ type: 'sandbox.log', incidentId: h.rec.id, sandboxId: sandbox.id, line }));
  let streamed = false;
  const res = await sandbox
    .exec(h.hub.deps.site.testCommand, {
      timeoutSec: TEST_TIMEOUT_SEC,
      onLine: (line) => {
        streamed = true;
        logs.push(`${line}\n`);
      },
    })
    .finally(() => logs.flush());
  if (!streamed) {
    // The adapter did not stream lines: publish the captured output after the fact.
    for (const line of res.output.split('\n')) logs.push(`${line}\n`);
    logs.flush();
  }
  return res;
}

/** Compact evidence for the patch prompt: test output plus the failing flow's error and page errors. */
export function reproEvidence(testOutput: string | undefined, run: FlowRunResult): string {
  const parts: string[] = [];
  if (testOutput?.trim()) parts.push(`test output:\n${truncate(testOutput, 2500)}`);
  const step = run.steps.find((s) => s.index === run.failedStep);
  parts.push(`flow ${run.flowId}: ${run.ok ? 'passed' : `failed${step ? ` at step "${step.name}"` : ''}`}${run.error ? `\nerror: ${run.error.message}` : ''}`);
  if (run.error?.stack) parts.push(truncate(run.error.stack, 800));
  if (run.consoleErrors.length) parts.push(`console errors:\n${truncate(run.consoleErrors.join('\n'), 800)}`);
  if (run.pageErrors.length) parts.push(`page errors:\n${truncate(run.pageErrors.join('\n'), 1200)}`);
  return truncate(parts.join('\n\n'), 6000);
}

/** 4. reproduce: rebuild the live site in a sandbox, run its tests and the incident flow against a preview. */
export async function reproduce(h: Heal): Promise<void> {
  const { sandboxes, deployer, site } = h.hub.deps;
  const flow = h.flow;
  if (!flow) throw new Error(`flow "${h.rec.flowId ?? '?'}" is not registered`);

  await stage(h, 'reproduce', 'TOOL', 'booting sandbox', async (ctl) => {
    const sandbox = await sandboxes.create({ label: h.rec.id, incidentId: h.rec.id });
    h.sandbox = sandbox;
    h.hub.emit({ type: 'sandbox.created', incidentId: h.rec.id, sandboxId: sandbox.id, provider: sandbox.provider });

    const started = Date.now();
    h.liveFiles = await deployer.liveFiles();
    await sandbox.writeFiles(site.sandboxFiles(h.liveFiles));
    const tests = await runTests(h, sandbox);
    const preview = await sandbox.serveStatic('site', PREVIEW_PORT);
    h.previewUrl = preview.url.replace(/\/+$/, '');

    const testsFailed = tests.exitCode !== 0;
    let run = await h.hub.runFlow(flow, 'reproduce', h.rec.id, h.previewUrl);
    let reproduced = !run.ok || testsFailed;
    if (!reproduced) {
      run = await h.hub.runFlow(flow, 'reproduce', h.rec.id, h.previewUrl);
      reproduced = !run.ok || testsFailed;
    }

    const evidence = run.ok ? h.failing : run;
    h.reproOutput = reproEvidence(tests.output, evidence);
    const flowPart = run.ok
      ? `flow "${flow.name}" passed`
      : `flow "${flow.name}" failed${run.failedStep !== undefined ? ` at step "${run.steps.find((s) => s.index === run.failedStep)?.name ?? '?'}"` : ''}: ${run.error?.message ?? 'unknown error'}`;
    const summary = `${flowPart}; tests ${testsFailed ? `failed (exit ${tests.exitCode})` : 'passed'}`;
    h.hub.emit({
      type: 'sandbox.result', incidentId: h.rec.id, sandboxId: sandbox.id, phase: 'reproduce',
      passed: !reproduced, summary, durationMs: Date.now() - started, previewUrl: h.previewUrl,
    });

    if (!reproduced) {
      ctl.detail = 'not reproduced after a retry';
      throw new Closed('not_reproducible', 'could not reproduce the failure in a sandbox');
    }
    ctl.detail = `reproduced: ${summary}`;
  });
}
