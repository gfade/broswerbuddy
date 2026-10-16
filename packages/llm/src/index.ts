/**
 * @healops/llm: Claude for HealOps.
 *   proposePatch → Claude Opus 5.5 (streamed, summarised thinking, structured output)
 *   judge / triage / screen → Claude Haiku 5.5 (structured output, low effort)
 *   embed → Amazon Titan Text Embeddings V2 (256-d)
 *   screen → Bedrock Guardrails when configured, else a Claude classifier, with a regex pre-filter
 * Non-critical calls degrade to deterministic heuristics if a live call fails.
 */
import { BedrockRuntimeClient, ApplyGuardrailCommand } from '@aws-sdk/client-bedrock-runtime';
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import {
  createLogger, errorMessage, loadConfig,
  type EvalResult, type HealOpsConfig, type JudgeInput, type LLM, type LLMStreamHandlers, type PatchInput,
  type PatchProposal, type ScreenResult, type TriageInput, type TriageResult,
} from '@healops/shared';
import { makeClient, RefusalError, streamPatch, structured, type ClaudeClient } from './claude.js';
import { createEmbedder, hashEmbed } from './embed.js';
import { heuristicJudge, heuristicScreen, heuristicTriage, offlinePatch, weightedScore } from './offline.js';
import {
  JUDGE_SYSTEM, PATCH_SYSTEM, SCREEN_SYSTEM, TRIAGE_SYSTEM,
  judgePrompt, patchFilesBlock, patchIncidentBlock, screenPrompt, triagePrompt,
} from './prompts.js';
import { JudgeSchema, ScreenSchema, TriageSchema } from './schemas.js';

export { hashEmbed, weightedScore };

const log = createLogger('bedrock');

export function createLLM(cfg: HealOpsConfig = loadConfig()): LLM {
  const provider = cfg.llm.provider;
  const embedder = createEmbedder(cfg);

  if (provider === 'offline') {
    log.warn('no Bedrock or Anthropic credentials: LLM running in OFFLINE mode (canned fixes, heuristic judge)');
    return {
      provider,
      models: { patch: 'offline-canned', judge: 'heuristic', triage: 'heuristic', embed: embedder.model },
      guardrails: 'heuristic',
      embed: embedder.embed,
      screen: async (text) => heuristicScreen(text),
      triage: async (input) => heuristicTriage(input),
      proposePatch: (input, handlers) => offlinePatch(input, handlers),
      judge: async (input) => heuristicJudge(input),
    };
  }

  const client: ClaudeClient = makeClient(cfg, provider);
  const models = { patch: cfg.llm.patchModel, judge: cfg.llm.judgeModel, triage: cfg.llm.triageModel, embed: embedder.model };
  const guardrails: ScreenResult['provider'] =
    provider === 'bedrock' && cfg.bedrock.guardrailId ? 'bedrock-guardrails' : 'claude-classifier';
  const guardClient = guardrails === 'bedrock-guardrails' ? new BedrockRuntimeClient({ region: cfg.aws.region }) : undefined;
  const { patchModel, refusalFallbackModel, fastFallbackModel } = cfg.llm;
  // fast models can be switched at runtime if the account has no access to them
  const fast = { judge: cfg.llm.judgeModel, triage: cfg.llm.triageModel };
  log.info(`Claude via ${provider}${provider === 'bedrock' ? ` (${cfg.llm.bedrockClient})` : ''}: patch=${patchModel} judge=${fast.judge}`);

  /** structured() on a fast model, switching to the fallback model once if the model isn't enabled. */
  async function fastCall<T extends z.ZodType>(role: 'judge' | 'triage', system: string, prompt: string, schema: T) {
    try {
      return await structured(client, fast[role], system, prompt, schema);
    } catch (err) {
      const denied = err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError;
      if (!denied || fast[role] === fastFallbackModel) throw err;
      log.warn(`${fast[role]} is not enabled on this account (${(err as InstanceType<typeof Anthropic.APIError>).status}); using ${fastFallbackModel} for judge/triage/screening`);
      fast.judge = fastFallbackModel;
      fast.triage = fastFallbackModel;
      models.judge = fastFallbackModel;
      models.triage = fastFallbackModel;
      return structured(client, fastFallbackModel, system, prompt, schema);
    }
  }

  async function screen(text: string, kind: 'flag' | 'page' | 'output'): Promise<ScreenResult> {
    const pre = heuristicScreen(text); // cheap pre-filter for obvious injection attempts
    if (!pre.safe) return pre;
    try {
      if (guardClient) {
        const res = await guardClient.send(
          new ApplyGuardrailCommand({
            guardrailIdentifier: cfg.bedrock.guardrailId,
            guardrailVersion: cfg.bedrock.guardrailVersion,
            source: kind === 'output' ? 'OUTPUT' : 'INPUT',
            content: [{ text: { text } }],
          }),
          { abortSignal: AbortSignal.timeout(15_000) },
        );
        return res.action === 'GUARDRAIL_INTERVENED'
          ? { safe: false, reason: 'Bedrock Guardrails intervened', provider: 'bedrock-guardrails' }
          : { safe: true, provider: 'bedrock-guardrails' };
      }
      const r = await fastCall('triage', SCREEN_SYSTEM, screenPrompt(text, kind), ScreenSchema);
      if (r.refused) return { safe: false, reason: 'screening model declined to process this text', provider: 'claude-classifier' };
      return { safe: r.output.safe, reason: r.output.reason, provider: 'claude-classifier' };
    } catch (err) {
      log.warn(`screen failed (${describe(err)}); using heuristic screen`);
      return pre;
    }
  }

  async function triage(input: TriageInput): Promise<TriageResult> {
    try {
      const r = await fastCall('triage', TRIAGE_SYSTEM, triagePrompt(input), TriageSchema);
      if (r.refused) return heuristicTriage(input);
      return { severity: r.output.severity, category: r.output.category, isBug: r.output.is_bug, summary: r.output.summary, model: r.model };
    } catch (err) {
      log.warn(`triage failed (${describe(err)}); using heuristic triage`);
      return heuristicTriage(input);
    }
  }

  async function proposePatch(input: PatchInput, handlers?: LLMStreamHandlers): Promise<PatchProposal> {
    const files = patchFilesBlock(input);
    const incident = patchIncidentBlock(input);
    const run = async (model: string) => {
      const r = await streamPatch(client, provider as 'bedrock' | 'anthropic', model, PATCH_SYSTEM, files, incident, handlers);
      const o = r.output;
      const proposal: PatchProposal = {
        summary: o.summary,
        rootCause: o.root_cause,
        reasoning: o.reasoning.slice(0, 5),
        confidence: Math.min(1, Math.max(0, o.confidence)),
        edits: o.edits,
        regressionTest: o.regression_test ?? undefined,
        model: r.model,
        provider,
        usage: r.usage,
      };
      return proposal;
    };
    try {
      return await run(patchModel);
    } catch (err) {
      if (err instanceof RefusalError && provider === 'bedrock') {
        log.warn(`${err.message}; retrying on fallback model ${refusalFallbackModel}`);
        return run(refusalFallbackModel);
      }
      if (input.offlineHint) {
        log.warn(`patch generation failed (${describe(err)}); using the offline reference fix`);
        return offlinePatch(input, handlers);
      }
      throw err;
    }
  }

  async function judge(input: JudgeInput): Promise<EvalResult> {
    try {
      const r = await fastCall('judge', JUDGE_SYSTEM, judgePrompt(input), JudgeSchema);
      if (r.refused) return heuristicJudge(input);
      const rubric = {
        correctness: r.output.correctness,
        minimality: r.output.minimality,
        testCoverage: r.output.test_coverage,
        safety: r.output.safety,
        memoryUse: r.output.memory_use,
      };
      return { score: weightedScore(rubric), rubric, verdict: r.output.verdict, model: r.model };
    } catch (err) {
      log.warn(`judge failed (${describe(err)}); using heuristic judge`);
      return heuristicJudge(input);
    }
  }

  return {
    provider,
    models,
    guardrails,
    embed: embedder.embed,
    screen,
    triage,
    proposePatch,
    judge,
  };
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.status ?? ''} ${err.message}`.trim();
  return errorMessage(err);
}
