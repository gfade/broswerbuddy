import {
  applyEdits,
  type ApplyEditsResult, type PatchInput, type PatchProposal,
} from '@healops/shared';
import { Closed, llmAttrs, softSync, type Heal } from './context.js';
import { reproEvidence, runTests } from './reproduce.js';
import { stage } from './stage.js';
import { Batcher } from './throttle.js';

/** Shared budget for patch proposals (rejected or failed-verification attempts both count). */
export const MAX_ATTEMPTS = 3;

function failedStepName(h: Heal): string | undefined {
  return h.failing.steps.find((s) => s.index === h.failing.failedStep)?.name;
}

/** One proposal from the LLM. Thinking and text deltas are batched onto the bus every ~150ms. */
async function propose(h: Heal): Promise<PatchProposal> {
  const { llm, site } = h.hub.deps;
  const seed = h.rec.flowId ? site.seeds.find((s) => s.flowId === h.rec.flowId) : undefined;
  const input: PatchInput = {
    incidentId: h.rec.id,
    title: h.rec.title,
    flowName: h.flow?.name,
    error: { message: h.failing.error?.message ?? h.rec.error, stack: h.failing.error?.stack },
    failedStep: failedStepName(h),
    consoleErrors: h.failing.consoleErrors,
    files: h.liveFiles,
    reproOutput: h.reproOutput,
    similarFixes: h.similarFixes,
    previousAttempts: h.previousAttempts,
    userReport: h.rec.userReport,
    offlineHint: llm.provider === 'offline' ? seed?.offlineFix : undefined,
  };
  const model = llm.models.patch;
  const delta = (kind: 'thinking' | 'text') => (text: string) =>
    h.hub.emit({ type: 'llm.delta', incidentId: h.rec.id, kind, text, model });
  const thinking = new Batcher(delta('thinking'), 150);
  const text = new Batcher(delta('text'), 150);
  try {
    return await llm.proposePatch(input, { onThinking: (d) => thinking.push(d), onText: (d) => text.push(d) });
  } finally {
    thinking.flush();
    text.flush();
  }
}

/**
 * 5. patch: propose edits until one applies cleanly to the live files.
 * Rejected edits are recorded and fed back into the next proposal.
 */
async function patchUntilApplied(h: Heal): Promise<{ proposal: PatchProposal; applied: ApplyEditsResult }> {
  const { llm } = h.hub.deps;
  return stage(h, 'patch', 'LLM', `attempt ${h.attempts + 1} of ${MAX_ATTEMPTS}`, async (ctl) => {
    for (;;) {
      if (h.attempts >= MAX_ATTEMPTS) {
        ctl.status = 'failed';
        ctl.detail = `no applicable patch after ${MAX_ATTEMPTS} attempts`;
        throw new Closed('escalated', ctl.detail);
      }
      h.attempts++;
      const attempt = h.attempts;
      const proposal = await propose(h);
      softSync('span.attrs', () =>
        ctl.span?.setAttributes(llmAttrs(proposal.model, proposal.provider, { title: h.rec.title, reproOutput: h.reproOutput }, proposal, proposal.usage)),
      );

      const applied = applyEdits(h.liveFiles, proposal.edits);
      const problems = [...applied.errors];
      if (problems.length === 0 && applied.changed.length === 0) problems.push('edits produced no change');
      if (problems.length > 0) {
        h.hub.emit({ type: 'patch.rejected', incidentId: h.rec.id, attempt, reason: problems.join('; ') });
        h.previousAttempts.push({ summary: proposal.summary, failure: `edits did not apply: ${problems.join('; ')}` });
        continue;
      }

      h.rec.patch = {
        summary: proposal.summary, rootCause: proposal.rootCause, diff: applied.diff,
        confidence: proposal.confidence, model: proposal.model,
      };
      h.hub.emit({
        type: 'patch.ready', incidentId: h.rec.id, attempt, summary: proposal.summary, rootCause: proposal.rootCause,
        reasoning: proposal.reasoning, confidence: proposal.confidence, diff: applied.diff, files: applied.changed,
        model: proposal.model, provider: proposal.provider,
      });
      ctl.detail = `attempt ${attempt}: ${proposal.summary} (${applied.changed.length} file(s), ${Math.round(proposal.confidence * 100)}% confident)`;
      return { proposal, applied };
    }
  }, llmAttrs(llm.models.patch, llm.provider));
}

/**
 * 6. verify: write the patched site (plus any regression test) into the same sandbox,
 * then rerun the tests and the incident flow against its preview. Returns whether it passed.
 */
async function verify(h: Heal, proposal: PatchProposal, applied: ApplyEditsResult): Promise<boolean> {
  const { site } = h.hub.deps;
  const flow = h.flow;
  const sandbox = h.sandbox;
  const previewUrl = h.previewUrl;
  if (!flow || !sandbox || !previewUrl) throw new Error('verify needs the sandbox and preview from reproduce');

  return stage(h, 'verify', 'TOOL', `rerunning tests and "${flow.name}"`, async (ctl) => {
    const started = Date.now();
    await sandbox.writeFiles(site.sandboxFiles(applied.files, proposal.regressionTest ? [proposal.regressionTest] : []));
    const tests = await runTests(h, sandbox);
    const run = await h.hub.runFlow(flow, 'verify', h.rec.id, previewUrl);
    const testsOk = tests.exitCode === 0;
    const passed = testsOk && run.ok;
    h.verifyOutput = reproEvidence(tests.output, run);
    const summary = `tests ${testsOk ? 'passed' : `failed (exit ${tests.exitCode})`}; flow "${flow.name}" ${run.ok ? 'passed' : `failed: ${run.error?.message ?? 'unknown error'}`}`;
    h.hub.emit({
      type: 'sandbox.result', incidentId: h.rec.id, sandboxId: sandbox.id, phase: 'verify',
      passed, summary, durationMs: Date.now() - started, previewUrl,
    });
    ctl.detail = summary;
    if (!passed) {
      ctl.status = 'failed';
      h.previousAttempts.push({ summary: proposal.summary, failure: summary });
    }
    return passed;
  });
}

/** Stages 5 and 6 together: patch and verify, retrying while the attempt budget lasts. */
export async function patchAndVerify(h: Heal): Promise<{ proposal: PatchProposal; applied: ApplyEditsResult }> {
  for (;;) {
    const { proposal, applied } = await patchUntilApplied(h);
    if (await verify(h, proposal, applied)) return { proposal, applied };
    if (h.attempts >= MAX_ATTEMPTS) {
      throw new Closed('escalated', `verification failed after ${h.attempts} attempts`);
    }
  }
}
