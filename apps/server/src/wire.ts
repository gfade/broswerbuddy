// OWNED BY THE LEAD ENGINEER: wires the real sponsor adapters into the runtime.
// Placeholder until the adapter packages land; run the server with HEALOPS_FAKE=1 meanwhile.
import type { HealOpsRuntime } from '@healops/shared';

export async function createHealOps(): Promise<HealOpsRuntime> {
  throw new Error('wire.ts is not implemented yet: start the server with HEALOPS_FAKE=1');
}
