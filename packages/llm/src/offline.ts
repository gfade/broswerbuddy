// Offline fallbacks: used when no LLM credentials are configured, or when a live call
// fails for a non-critical step. Everything here is deterministic and clearly labelled.
import type {
  EvalResult, JudgeInput, PatchInput, PatchProposal, ScreenResult, TriageInput, TriageResult, LLMStreamHandlers,
} from '@healops/shared';
import { sleep } from '@healops/shared';

const INJECTION = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts?)/i,
  /\b(system|developer) prompt\b/i,
  /\byou are now\b/i,
  /\b(api[_ -]?key|secret key|access key|password|credentials?|bearer token|session token|private key)\b/i,
  /\b(print|reveal|show|send|leak|exfiltrate|dump)\b.{0,40}\b(env|environment|secrets?|tokens?|keys?)\b/i,
  /\b(deploy|commit|push)\b.{0,30}\b(this|my|the following) code\b/i,
  /<script[\s>]/i,
  /BEGIN (RSA |OPENSSH )?PRIVATE KEY/,
];

export function heuristicScreen(text: string): ScreenResult {
  const hit = INJECTION.find((re) => re.test(text));
  return hit
    ? { safe: false, reason: `matched rule ${hit.source.slice(0, 60)}`, provider: 'heuristic' }
    : { safe: true, provider: 'heuristic' };
}

export function heuristicTriage(input: TriageInput): TriageResult {
  const text = `${input.title} ${input.error} ${input.flowName ?? ''}`.toLowerCase();
  const security = /xss|cve|inject|onerror|security/.test(text);
  const severity = security || /checkout|pay|cart|order/.test(text) ? 'sev1' : /signup|login|auth/.test(text) ? 'sev2' : 'sev3';
  const category = security
    ? 'security (xss)'
    : /typeerror|undefined|null/.test(text)
    ? 'null reference'
    : /valid|regex|email/.test(text)
      ? 'validation'
      : /intercept|overlay|click|pointer/.test(text)
        ? 'css/layout'
        : 'functional';
  return { severity, category, isBug: true, summary: input.title, model: 'heuristic' };
}

export async function offlinePatch(input: PatchInput, handlers?: LLMStreamHandlers): Promise<PatchProposal> {
  const hint = input.offlineHint;
  if (!hint) throw new Error('offline mode: no canned fix is available for this bug (configure Bedrock or an Anthropic key)');
  const thoughts = [
    `Offline mode (no LLM credentials): replaying the reference fix for this seeded bug.\n`,
    `The failing step points at ${input.error.message.slice(0, 120)}.\n`,
    `Root cause: ${hint.rootCause}\n`,
  ];
  for (const t of thoughts) {
    handlers?.onThinking?.(t);
    await sleep(250);
  }
  return {
    summary: hint.summary,
    rootCause: hint.rootCause,
    reasoning: ['Offline mode: canned reference fix', hint.rootCause],
    confidence: 0.7,
    edits: hint.edits,
    model: 'offline-canned',
    provider: 'offline',
  };
}

export function heuristicJudge(input: JudgeInput): EvalResult {
  const changed = input.diff.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length;
  const minimality = changed <= 6 ? 0.95 : changed <= 20 ? 0.8 : 0.6;
  const testCoverage = /test/.test(input.diff) ? 0.9 : input.verifyOutput ? 0.7 : 0.5;
  const correctness = input.verifyOutput && !/fail/i.test(input.verifyOutput) ? 0.85 : 0.6;
  const safety = /auth|password|secret|token/i.test(input.diff) ? 0.6 : 1;
  const memoryUse = input.usedMemory ? 0.95 : 1;
  const rubric = { correctness, minimality, testCoverage, safety, memoryUse };
  return { score: weightedScore(rubric), rubric, verdict: 'Heuristic score (offline mode, no LLM judge).', model: 'heuristic' };
}

export function weightedScore(r: EvalResult['rubric']): number {
  const clamp = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
  const s = 0.35 * clamp(r.correctness) + 0.2 * clamp(r.minimality) + 0.2 * clamp(r.testCoverage) + 0.15 * clamp(r.safety) + 0.1 * clamp(r.memoryUse);
  return Math.round(s * 100);
}
