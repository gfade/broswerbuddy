// Claude clients and calls. Bedrock (this hackathon account) is reached through the
// bedrock-runtime client with cross-region inference profiles; the Mantle client and the
// first-party Anthropic API are supported too.
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock, AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { HealOpsConfig, LLMProvider, LLMStreamHandlers } from '@healops/shared';
import { PatchSchema, type PatchOutput } from './schemas.js';

/** The slice of the SDK surface HealOps uses; all three client classes provide it. */
export interface ClaudeClient {
  messages: Pick<Anthropic['messages'], 'parse'>;
  beta: { messages: Pick<Anthropic['beta']['messages'], 'stream'> };
}

export class RefusalError extends Error {
  constructor(
    readonly model: string,
    readonly category: string | null | undefined,
  ) {
    super(`model ${model} declined the request${category ? ` (category: ${category})` : ''}`);
  }
}

export function makeClient(cfg: HealOpsConfig, provider: Exclude<LLMProvider, 'offline'>): ClaudeClient {
  if (provider === 'anthropic') {
    return new Anthropic({ apiKey: cfg.anthropic.apiKey, maxRetries: 2 }) as unknown as ClaudeClient;
  }
  // Credentials resolve from the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN).
  return (
    cfg.llm.bedrockClient === 'mantle'
      ? new AnthropicBedrockMantle({ awsRegion: cfg.aws.region, maxRetries: 2 })
      : new AnthropicBedrock({ awsRegion: cfg.aws.region, maxRetries: 2 })
  ) as unknown as ClaudeClient;
}

export interface PatchCallResult {
  output: PatchOutput;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Patch generation: streamed so the dashboard can show Claude's (summarised) reasoning live,
 * with structured output so the result is a validated object.
 */
export async function streamPatch(
  client: ClaudeClient,
  provider: Exclude<LLMProvider, 'offline'>,
  model: string,
  system: string,
  filesBlock: string,
  incidentBlock: string,
  handlers?: LLMStreamHandlers,
): Promise<PatchCallResult> {
  const stream = client.beta.messages.stream(
    {
      model,
      max_tokens: 64000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high', format: betaZodOutputFormat(PatchSchema) },
      system,
      messages: [
        {
          role: 'user',
          content: [
            // the source is identical across retries of one incident: cache it
            { type: 'text', text: filesBlock, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: incidentBlock },
          ],
        },
      ],
      // Server-side refusal fallback is a first-party API feature; Bedrock gets a client-side retry instead.
      ...(provider === 'anthropic' ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    },
    { timeout: 300_000 },
  );

  for await (const event of stream) {
    if (event.type !== 'content_block_delta') continue;
    if (event.delta.type === 'thinking_delta') handlers?.onThinking?.(event.delta.thinking);
    else if (event.delta.type === 'text_delta') handlers?.onText?.(event.delta.text);
  }
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') throw new RefusalError(model, message.stop_details?.category);
  if (message.stop_reason === 'max_tokens') throw new Error('patch response was truncated (max_tokens)');
  const output = message.parsed_output;
  if (!output) throw new Error('patch response did not contain valid structured output');
  return {
    output,
    model: message.model ?? model,
    usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
  };
}

/** Small structured calls (judge / triage / screen) on the fast model. */
export async function structured<T extends z.ZodType>(
  client: ClaudeClient,
  model: string,
  system: string,
  prompt: string,
  schema: T,
): Promise<{ output: z.infer<T>; model: string; refused: boolean }> {
  const message = await client.messages.parse(
    {
      model,
      max_tokens: 16000,
      output_config: { effort: 'low', format: zodOutputFormat(schema) },
      system,
      messages: [{ role: 'user', content: prompt }],
    },
    { timeout: 90_000 },
  );
  if (message.stop_reason === 'refusal') return { output: undefined as z.infer<T>, model, refused: true };
  if (message.parsed_output == null) throw new Error(`no structured output (stop_reason=${message.stop_reason})`);
  return { output: message.parsed_output as z.infer<T>, model: message.model ?? model, refused: false };
}
