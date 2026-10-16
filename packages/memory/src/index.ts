/**
 * @healops/memory: agent memory on SurrealDB (graph + vectors), with an in-process fallback.
 *
 *   const memory = await createMemory();   // SurrealDB cloud if SURREAL_URL is set, else embedded, else in-memory
 *   await seedHistory(memory, embed);      // demo history; a no-op once the memory holds bugs
 */
import { createLogger, errorMessage, loadConfig, type HealOpsConfig, type Memory } from '@healops/shared';
import { InMemoryMemory } from './in-memory.js';

export { hashEmbed } from './embed.js';
export { seedHistory } from './seed.js';

const log = createLogger('surreal');

/**
 * Opens the memory store and returns it initialised (schema in place).
 * SurrealDB cloud when cfg.surreal.url is set. If that cannot be reached or signed in to, or when
 * the URL is not set, the embedded engine is used (SurrealKV under <dataDir>/surreal). If SurrealDB
 * cannot start at all, a pure TypeScript in-memory store is returned. The chosen provider is logged.
 */
export async function createMemory(cfg: HealOpsConfig = loadConfig()): Promise<Memory> {
  const surreal = await loadSurrealProvider();
  if (surreal && cfg.surreal.url) {
    try {
      return await surreal.openSurrealMemory(cfg, 'cloud');
    } catch (err) {
      log.warn(`SurrealDB cloud unavailable (${errorMessage(err)}); falling back to the local store`);
    }
  }
  if (surreal) {
    try {
      return await surreal.openSurrealMemory(cfg, 'embedded');
    } catch (err) {
      log.warn(`SurrealDB embedded unavailable (${errorMessage(err)}); falling back to the in-memory store`);
    }
  }
  return createInMemoryMemory();
}

/** An initialised in-process memory with the same semantics; nothing is persisted. */
export async function createInMemoryMemory(): Promise<Memory> {
  const memory = new InMemoryMemory();
  await memory.init();
  log.info('memory provider: in-memory (not persisted)');
  return memory;
}

/** Loaded lazily so a broken SurrealDB install only disables the SurrealDB providers. */
async function loadSurrealProvider(): Promise<typeof import('./surreal.js') | undefined> {
  try {
    return await import('./surreal.js');
  } catch (err) {
    log.warn(`SurrealDB client could not load (${errorMessage(err)})`);
    return undefined;
  }
}
