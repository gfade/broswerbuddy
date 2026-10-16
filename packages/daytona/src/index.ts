/**
 * @healops/daytona: sandboxes for the reproduce/verify stages.
 * Daytona when DAYTONA_API_KEY is configured, otherwise a local folder-based fallback.
 */
import { loadConfig, type HealOpsConfig, type SandboxProvider } from '@healops/shared';
import { DaytonaSandboxProvider } from './daytona.js';
import { LocalSandboxProvider } from './local.js';

export function createSandboxProvider(cfg: HealOpsConfig = loadConfig()): SandboxProvider {
  return cfg.daytona.enabled ? new DaytonaSandboxProvider(cfg.daytona) : new LocalSandboxProvider(cfg.dataDir);
}
