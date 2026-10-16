import { EMBED_DIM } from '@healops/shared';

/**
 * Deterministic offline stand-in for an embedding model (tests and fallback): character trigrams
 * are hashed into EMBED_DIM buckets, counted, and L2-normalised. Strings that share text share
 * trigrams, so their cosine similarity is high.
 */
export function hashEmbed(text: string): number[] {
  const vector = new Array<number>(EMBED_DIM).fill(0);
  const normalised = ` ${String(text).toLowerCase().replace(/\s+/g, ' ').trim()} `;
  for (let i = 0; i + 3 <= normalised.length; i++) {
    vector[fnv1a(normalised.slice(i, i + 3)) % EMBED_DIM] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((x) => x / norm);
}

/** 32-bit FNV-1a, unsigned. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash = Math.imul(hash ^ input.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash;
}
