// Wires the real sponsor adapters into the runtime. Every adapter falls back to a local implementation without keys.
import { loadConfig, type HealOpsRuntime } from '@healops/shared';
import { createLLM } from '@healops/llm';
import { createBrowserRunner } from '@healops/anchor';
import { createSandboxProvider } from '@healops/daytona';
import { createMemory, seedHistory } from '@healops/memory';
import { createTelemetry } from '@healops/telemetry';
import { createDeployer } from '@healops/deploy';
import { createRuntime } from '@healops/agent';
import { loadSite, sandboxFiles, seeds, applySeed, DEFAULT_SEED, SITE_VERSION, TEST_COMMAND } from '@healops/demo-store';
import { flows } from '@healops/demo-store/flows';

export async function createHealOps(): Promise<HealOpsRuntime> {
  const config = loadConfig();
  return createRuntime({
    config,
    llm: createLLM(config),
    browser: createBrowserRunner(config),
    sandboxes: createSandboxProvider(config),
    memory: await createMemory(config),
    telemetry: createTelemetry(config),
    deployer: createDeployer(config),
    site: {
      version: SITE_VERSION, loadSite, sandboxFiles, testCommand: TEST_COMMAND, seeds, applySeed,
      defaultSeed: process.env.HEALOPS_INITIAL_SEED ?? DEFAULT_SEED,
    },
    flows,
    seedHistory,
  });
}
