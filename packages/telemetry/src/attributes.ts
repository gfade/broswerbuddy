/**
 * OpenInference attribute builders. Keys come from @arizeai/openinference-semantic-conventions
 * so they track the spec; the eval.<name>.* keys follow Arize's evaluation convention.
 */
import {
  INPUT_VALUE,
  LLM_INVOCATION_PARAMETERS,
  LLM_MODEL_NAME,
  LLM_PROVIDER,
  LLM_SYSTEM,
  LLM_TOKEN_COUNT_COMPLETION,
  LLM_TOKEN_COUNT_PROMPT,
  LLM_TOKEN_COUNT_TOTAL,
  LLMProvider,
  LLMSystem,
  OUTPUT_VALUE,
} from '@arizeai/openinference-semantic-conventions';
import { truncate, type Attr } from '@healops/shared';

/** Prompts and completions are clipped so a single span cannot bloat the OTLP payload. */
export const MAX_TEXT_CHARS = 8192;

export interface LLMAttributeInput {
  model: string;
  /** LLMProvider from @healops/shared: 'bedrock' | 'anthropic' | 'offline' */
  provider: string;
  inputTokens?: number;
  outputTokens?: number;
  input?: string;
  output?: string;
  invocation?: Record<string, unknown>;
}

export interface EvalAttributeInput {
  score: number;
  label?: string;
  explanation?: string;
}

/** Attributes for an LLM span. Token totals are only reported when both counts are known. */
export function llmAttributes(p: LLMAttributeInput): Record<string, Attr> {
  const attrs: Record<string, Attr> = {
    [LLM_MODEL_NAME]: p.model,
    [LLM_PROVIDER]: llmProviderKey(p.provider),
    [LLM_SYSTEM]: llmSystemKey(p.model, p.provider),
  };
  const prompt = finiteCount(p.inputTokens);
  const completion = finiteCount(p.outputTokens);
  if (prompt !== undefined) attrs[LLM_TOKEN_COUNT_PROMPT] = prompt;
  if (completion !== undefined) attrs[LLM_TOKEN_COUNT_COMPLETION] = completion;
  if (prompt !== undefined && completion !== undefined) attrs[LLM_TOKEN_COUNT_TOTAL] = prompt + completion;
  if (p.input !== undefined) attrs[INPUT_VALUE] = truncate(p.input, MAX_TEXT_CHARS);
  if (p.output !== undefined) attrs[OUTPUT_VALUE] = truncate(p.output, MAX_TEXT_CHARS);
  const invocation = p.invocation === undefined ? undefined : toJson(p.invocation);
  if (invocation !== undefined) attrs[LLM_INVOCATION_PARAMETERS] = truncate(invocation, MAX_TEXT_CHARS);
  return attrs;
}

/** Arize evaluation attributes: eval.<name>.score / .label / .explanation. */
export function evalAttributes(name: string, e: EvalAttributeInput): Record<string, Attr> {
  const base = `eval.${name}`;
  const attrs: Record<string, Attr> = {};
  if (Number.isFinite(e.score)) attrs[`${base}.score`] = e.score;
  if (e.label !== undefined) attrs[`${base}.label`] = e.label;
  if (e.explanation !== undefined) attrs[`${base}.explanation`] = truncate(e.explanation, MAX_TEXT_CHARS);
  return attrs;
}

/** Bedrock models are hosted by AWS; OpenInference records the cloud provider as 'aws'. */
function llmProviderKey(provider: string): string {
  return provider === 'bedrock' ? LLMProvider.AWS : provider;
}

/** Claude models (direct or via Bedrock) are made by Anthropic. */
function llmSystemKey(model: string, provider: string): string {
  return /claude|anthropic/i.test(model) ? LLMSystem.ANTHROPIC : provider;
}

function finiteCount(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function toJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
