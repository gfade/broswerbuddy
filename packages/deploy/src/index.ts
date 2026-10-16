import { loadConfig, type Deployer, type HealOpsConfig } from '@healops/shared';
import { LocalDeployer } from './local.js';
import { S3Deployer } from './s3.js';

export { provisionS3Site } from './s3.js';

/**
 * The deployer for this config: S3 when HEALOPS_S3_BUCKET and AWS credentials are both set,
 * otherwise the local host.
 */
export function createDeployer(cfg: HealOpsConfig = loadConfig()): Deployer {
  if (cfg.aws.enabled && cfg.aws.s3Bucket) return new S3Deployer(cfg);
  return new LocalDeployer(cfg);
}
