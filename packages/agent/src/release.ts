import type { ApplyEditsResult, PatchProposal } from '@healops/shared';
import { Closed, llmAttrs, soft, softSync, type Heal } from './context.js';
import { assessRisk, countChangedLines, decide } from './risk.js';
import { checkpoint, stage } from './stage.js';

/**
 * 7. gate: a pre-deploy judge score plus the patch's size, paths and confidence give a risk score;
 * the autonomy level turns it into auto / needs_approval / blocked. needs_approval waits for approve().
 */
export async function gate(h: Heal, proposal: PatchProposal, applied: ApplyEditsResult): Promise<void> {
  const { llm, config } = h.hub.deps;
  await stage(h, 'gate', 'EVALUATOR', 'scoring risk', async (ctl) => {
    const pre = await llm.judge({
      title: h.rec.title,
      error: h.rec.error,
      rootCause: proposal.rootCause,
      diff: applied.diff,
      reproOutput: h.reproOutput,
      verifyOutput: h.verifyOutput,
      usedMemory: Boolean(h.rec.memoryHit),
    });
    softSync('span.attrs', () => ctl.span?.setAttributes(llmAttrs(pre.model, llm.provider, undefined, pre)));
    const { risk, reasons } = assessRisk({
      changedFiles: applied.changed,
      changedLines: countChangedLines(applied.diff),
      confidence: proposal.confidence,
      preScore: pre.score,
    });
    const decision = decide(config.autonomy, risk, config.riskThreshold);
    h.hub.emit({ type: 'gate.decision', incidentId: h.rec.id, risk, decision, reasons, preScore: pre.score });
    softSync('span.attrs', () => ctl.span?.setAttributes({ 'healops.risk': risk, 'healops.gate': decision }));

    if (decision === 'blocked') {
      ctl.detail = `risk ${risk}: observe mode, patch suggested but not deployed`;
      throw new Closed('escalated', ctl.detail);
    }
    if (decision === 'needs_approval') {
      h.rec.status = 'awaiting_approval';
      await h.hub.persist(h.rec);
      const approved = await new Promise<boolean>((resolve) => {
        h.rec.approval = { settle: resolve };
      });
      h.rec.approval = undefined;
      checkpoint(h);
      if (!approved) {
        ctl.detail = `risk ${risk}: rejected by a human`;
        throw new Closed('rejected', ctl.detail);
      }
      h.rec.status = 'healing';
      await h.hub.persist(h.rec);
      ctl.detail = `risk ${risk}: approved by a human`;
      return;
    }
    ctl.detail = `risk ${risk} < ${config.riskThreshold}: auto-deploy`;
  });
}

/** 8. deploy: stage a canary, smoke-test it with the incident flow, promote or discard. */
export async function deploy(h: Heal, applied: ApplyEditsResult, nextVersion: () => Promise<string>): Promise<void> {
  const { deployer } = h.hub.deps;
  const flow = h.flow;
  if (!flow) throw new Error('deploy needs the incident flow');
  await stage(h, 'deploy', 'TOOL', 'staging canary', async (ctl) => {
    const version = await nextVersion();
    const provider = deployer.provider;
    const { canaryUrl } = await deployer.stageCanary(version, applied.files);
    const url = canaryUrl.replace(/\/+$/, '');
    h.hub.emit({ type: 'deploy.progress', incidentId: h.rec.id, phase: 'canary', version, ok: true, url, provider });

    const smoke = await h.hub.runFlow(flow, 'smoke', h.rec.id, url);
    h.hub.emit({
      type: 'deploy.progress', incidentId: h.rec.id, phase: 'smoke', version, ok: smoke.ok, url, provider,
      detail: smoke.ok ? `"${flow.name}" passed on the canary` : smoke.error?.message,
    });
    if (!smoke.ok) {
      h.deployOutcome = 'rolled_back';
      h.hub.emit({ type: 'deploy.progress', incidentId: h.rec.id, phase: 'rolled_back', version, ok: false, provider, detail: 'canary discarded' });
      ctl.status = 'failed';
      ctl.detail = `canary ${version} failed its smoke test: ${smoke.error?.message ?? 'unknown error'}`;
      throw new Closed('rolled_back', ctl.detail);
    }

    await deployer.promote(version);
    h.deployOutcome = 'promoted';
    const live = deployer.liveUrl();
    h.hub.emit({ type: 'deploy.progress', incidentId: h.rec.id, phase: 'promoted', version, ok: true, url: live, provider });
    h.hub.emit({ type: 'store.version', version, url: live, note: `healed ${h.rec.id}: ${h.rec.patch?.summary ?? ''}`.trim() });
    ctl.detail = `v${version} promoted after a green canary`;
  });
}

/** 9. judge: score the shipped fix end to end. */
export async function judge(h: Heal, proposal: PatchProposal, applied: ApplyEditsResult): Promise<void> {
  const { llm, telemetry } = h.hub.deps;
  await stage(h, 'judge', 'EVALUATOR', 'scoring the fix', async (ctl) => {
    const ev = await llm.judge({
      title: h.rec.title,
      error: h.rec.error,
      rootCause: proposal.rootCause,
      diff: applied.diff,
      reproOutput: h.reproOutput,
      verifyOutput: h.verifyOutput,
      usedMemory: Boolean(h.rec.memoryHit),
      deployOutcome: h.deployOutcome,
    });
    h.rec.score = ev.score;
    h.rec.eval = ev;
    softSync('span.attrs', () =>
      ctl.span?.setAttributes({ ...llmAttrs(ev.model, llm.provider, undefined, ev), 'eval.score': ev.score, 'eval.verdict': ev.verdict }),
    );
    const traceUrl = h.rec.traceId ? softSync('telemetry.traceUrl', () => telemetry.traceUrl(h.rec.traceId!)) : undefined;
    h.hub.emit({ type: 'eval.scored', incidentId: h.rec.id, score: ev.score, rubric: ev.rubric, verdict: ev.verdict, model: ev.model, traceUrl });
    ctl.detail = `${ev.score}/100: ${ev.verdict}`;
  }, llmAttrs(llm.models.judge, llm.provider));
}

/** 10. learn: store the fix in the memory graph so the next similar bug recalls it. */
export async function learn(h: Heal, proposal: PatchProposal, applied: ApplyEditsResult): Promise<void> {
  const { memory } = h.hub.deps;
  await stage(h, 'learn', 'TOOL', 'writing the fix to memory', async (ctl) => {
    const bugId = h.rec.bugId;
    if (!bugId) {
      ctl.detail = 'bug was not recorded; nothing to link';
      return;
    }
    const fix = await soft('memory.recordFix', () =>
      memory.recordFix({
        bugId, incidentId: h.rec.id, summary: proposal.summary, rootCause: proposal.rootCause,
        diff: applied.diff, files: applied.changed, verified: true, deployed: h.deployOutcome === 'promoted', score: h.rec.score,
      }),
    );
    if (!fix) {
      ctl.detail = 'memory write failed';
      return;
    }
    h.rec.fixId = fix.id;
    if (h.rec.eval) await soft('memory.recordEval', () => memory.recordEval(fix.id, h.rec.eval!));
    const edges = h.links + 1 + applied.changed.length;
    h.hub.emit({ type: 'memory.learned', incidentId: h.rec.id, bugId, fixId: fix.id, edges });
    ctl.detail = `bug ${bugId} → fix ${fix.id} (${edges} edges)`;
  });
}
