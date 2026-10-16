import { errorSignature } from '@healops/shared';
import { Closed, llmAttrs, soft, softSync, type Heal } from './context.js';
import { stage } from './stage.js';

/** 1. detect: which step failed and why. incident.opened is emitted when the incident is created. */
export async function detect(h: Heal): Promise<void> {
  await stage(h, 'detect', 'TOOL', `replaying "${h.flow?.name ?? h.rec.flowId ?? 'flow'}"`, async (ctl) => {
    const f = h.failing;
    const step = f.steps.find((s) => s.index === f.failedStep);
    ctl.detail = `failed step "${step?.name ?? 'unknown'}": ${h.rec.error}`;
  });
}

/** 2. triage: safety screen first, then severity and category. An unsafe report closes as quarantined. */
export async function triage(h: Heal): Promise<void> {
  const { llm } = h.hub.deps;
  const incidentId = h.rec.id;
  await stage(h, 'triage', 'GUARDRAIL', 'screening and classifying', async (ctl) => {
    const isFlag = h.rec.userReport !== undefined;
    const screened = await llm.screen(h.rec.userReport ?? h.rec.error, isFlag ? 'flag' : 'page');
    if (!screened.safe) {
      h.hub.emit({
        type: 'triage.result', incidentId, safe: false, guard: screened.provider, severity: h.rec.severity,
        category: 'unsafe', summary: 'Quarantined: report failed the safety screen', reason: screened.reason ?? 'flagged as unsafe',
      });
      ctl.detail = `quarantined: ${screened.reason ?? 'unsafe content'}`;
      throw new Closed('quarantined', ctl.detail);
    }

    const t = await llm.triage({
      title: h.rec.title,
      error: h.rec.error,
      source: h.rec.source,
      userReport: h.rec.userReport,
      flowName: h.flow?.name,
    });
    softSync('span.attrs', () => ctl.span?.setAttributes(llmAttrs(t.model, llm.provider, h.rec.error, t)));
    h.rec.severity = t.severity;
    h.hub.emit({
      type: 'triage.result', incidentId, safe: true, guard: llm.guardrails,
      severity: t.severity, category: t.category, summary: t.summary,
    });
    ctl.detail = `${t.severity} ${t.category}${t.isBug ? '' : ' (not confirmed as a bug)'}: ${t.summary}`;
  }, llmAttrs(llm.models.triage, llm.provider));
}

/** 3. recall: embed the failure signature, find similar past bugs and their fixes, and remember this bug. */
export async function recall(h: Heal): Promise<void> {
  const { llm, memory } = h.hub.deps;
  await stage(h, 'recall', 'RETRIEVER', 'searching memory for similar bugs', async (ctl) => {
    const message = h.failing.error?.message ?? h.rec.error;
    const stack = h.failing.error?.stack;
    const signature = errorSignature(message, stack);
    const head = (stack ?? '').split('\n').slice(0, 5).join('\n');
    const embedding = await llm.embed(`${signature}\n${head}`);

    const similar = (await soft('memory.similarBugs', () =>
      memory.similarBugs(embedding, { limit: 3, minSimilarity: 0.55 }),
    )) ?? [];
    h.similar = similar;
    h.similarFixes = similar
      .flatMap((s) => s.fixes.slice(0, 1).map((f) => ({ summary: f.summary, rootCause: f.rootCause, diff: f.diff, similarity: s.similarity })))
      .slice(0, 3);

    const bug = await soft('memory.recordBug', () =>
      memory.recordBug({
        incidentId: h.rec.id, signature, flowId: h.rec.flowId, errorMessage: message, stack,
        severity: h.rec.severity, embedding,
      }),
    );
    if (bug) {
      h.rec.bugId = bug.id;
      for (const s of similar) {
        await soft('memory.linkSimilar', () => memory.linkSimilar(bug.id, s.bug.id, s.similarity));
        h.links++;
      }
      h.hub.emit({
        type: 'memory.match', incidentId: h.rec.id, bugId: bug.id,
        matches: similar.map((s) => ({
          bugId: s.bug.id,
          similarity: s.similarity,
          signature: s.bug.signature,
          fixSummary: s.fixes[0]?.summary,
          score: s.fixes[0]?.score,
        })),
      });
    }

    const hit = similar.find((s) => s.fixes.length > 0);
    if (hit) h.rec.memoryHit = hit.bug.id;
    ctl.detail = `${similar.length} similar past bug(s)${hit ? `, fix on record from ${hit.bug.id}` : ', no fix on record'}`;
  }, { 'healops.signature': undefined });
}
