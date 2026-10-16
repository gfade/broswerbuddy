// Embeddings for memory recall: Amazon Titan Text Embeddings V2 on Bedrock (256 dims),
// with a deterministic local hashing embedding as the offline fallback.
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { EMBED_DIM, createLogger, type HealOpsConfig } from '@healops/shared';

const log = createLogger('bedrock');

/** Deterministic 256-d, L2-normalised character-trigram hashing embedding. */
export function hashEmbed(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  const s = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
  for (let i = 0; i < s.length - 2; i++) {
    let h = 2166136261;
    for (let j = i; j < i + 3; j++) h = Math.imul(h ^ s.charCodeAt(j), 16777619);
    v[(h >>> 0) % EMBED_DIM] += 1;
  }
  return normalize(v);
}

function normalize(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

export function createEmbedder(cfg: HealOpsConfig): { model: string; embed(text: string): Promise<number[]> } {
  if (!cfg.aws.enabled) return { model: 'local-hash-256', embed: async (t) => hashEmbed(t) };
  const client = new BedrockRuntimeClient({ region: cfg.aws.region });
  let warned = false;
  return {
    model: cfg.bedrock.embedModel,
    async embed(text: string) {
      try {
        const res = await client.send(
          new InvokeModelCommand({
            modelId: cfg.bedrock.embedModel,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({ inputText: text.slice(0, 8000), dimensions: EMBED_DIM, normalize: true }),
          }),
          { abortSignal: AbortSignal.timeout(15_000) },
        );
        const json = JSON.parse(new TextDecoder().decode(res.body)) as { embedding?: number[] };
        if (!json.embedding || json.embedding.length !== EMBED_DIM) throw new Error('unexpected embedding shape');
        return json.embedding;
      } catch (err) {
        if (!warned) log.warn(`Titan embeddings failed, using local hash embeddings: ${(err as Error).message}`);
        warned = true;
        return hashEmbed(text);
      }
    },
  };
}
