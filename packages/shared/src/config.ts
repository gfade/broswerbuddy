/**
 * Central configuration. Loads <repo>/.env once, then exposes typed settings.
 * Every sponsor is optional: `enabled` is false when its credentials are missing,
 * and the matching adapter falls back to a local implementation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Autonomy, LLMProvider } from './types.js';

function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        if (json.workspaces) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const ROOT = findRoot();

let envLoaded = false;
function loadEnvOnce(): void {
  if (envLoaded) return;
  envLoaded = true;
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch (err) {
      console.warn('[config] could not load .env:', (err as Error).message);
    }
  }
}

const str = (name: string): string | undefined => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};
const num = (name: string, fallback: number): number => {
  const v = Number(str(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export interface HealOpsConfig {
  root: string;
  /** <root>/.healops — runtime state, deploy copies, sandboxes, artifacts */
  dataDir: string;
  artifactsDir: string;
  serverPort: number;
  storePort: number;
  publicApiUrl: string;
  /** public URL of the store if one is configured (tunnel / S3) */
  publicStoreUrl?: string;
  autonomy: Autonomy;
  riskThreshold: number;
  patrolIntervalSec: number;
  anchor: { enabled: boolean; apiKey?: string };
  daytona: { enabled: boolean; apiKey?: string; apiUrl?: string; target?: string };
  aws: {
    enabled: boolean;
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    s3Bucket?: string;
  };
  bedrock: { guardrailId?: string; guardrailVersion: string; embedModel: string };
  anthropic: { enabled: boolean; apiKey?: string };
  llm: {
    provider: LLMProvider;
    /** which Bedrock client to use: 'runtime' (InvokeModel, inference profiles) or 'mantle' */
    bedrockClient: 'runtime' | 'mantle';
    patchModel: string;
    judgeModel: string;
    triageModel: string;
    /** used for a client-side retry when the patch model declines (Bedrock) */
    refusalFallbackModel: string;
    /** fast-model fallback when the judge/triage model is not enabled on the account */
    fastFallbackModel: string;
  };
  surreal: {
    enabled: boolean;
    url?: string;
    namespace: string;
    database: string;
    username?: string;
    password?: string;
    /** database token (JWT) for `url` */
    token?: string;
    /** Surreal Cloud personal access token (sdbp_…), control plane only */
    cloudToken?: string;
  };
  arize: { enabled: boolean; spaceId?: string; apiKey?: string; projectName: string; endpoint: string };
}

let cached: HealOpsConfig | undefined;

export function loadConfig(): HealOpsConfig {
  if (cached) return cached;
  loadEnvOnce();

  const dataDir = path.join(ROOT, '.healops');
  const awsRegion = str('AWS_REGION') ?? str('AWS_DEFAULT_REGION') ?? 'us-west-2';
  const awsEnabled = Boolean(str('AWS_ACCESS_KEY_ID') && str('AWS_SECRET_ACCESS_KEY'));
  const anthropicKey = str('ANTHROPIC_API_KEY');

  const requested = (str('HEALOPS_LLM_PROVIDER') ?? 'auto').toLowerCase();
  let provider: LLMProvider;
  if (requested === 'bedrock' || requested === 'anthropic' || requested === 'offline') provider = requested;
  else provider = awsEnabled ? 'bedrock' : anthropicKey ? 'anthropic' : 'offline';

  // Model IDs. On Bedrock these accounts serve Claude through cross-region inference
  // profiles ("us.anthropic.claude-…"), called via the bedrock-runtime client; the
  // Mantle endpoint takes bare "anthropic.claude-…" IDs instead.
  const bedrockClient = (str('HEALOPS_BEDROCK_CLIENT') ?? 'runtime') === 'mantle' ? 'mantle' : 'runtime';
  const geo = awsRegion.startsWith('us-') ? 'us.' : awsRegion.startsWith('eu-') ? 'eu.' : 'global.';
  const prefix = provider !== 'bedrock' ? '' : bedrockClient === 'mantle' ? 'anthropic.' : `${geo}anthropic.`;
  const patchModel = str('HEALOPS_PATCH_MODEL') ?? `${prefix}claude-opus-5-5`;
  const judgeModel = str('HEALOPS_JUDGE_MODEL') ?? `${prefix}claude-haiku-5-5`;
  const triageModel = str('HEALOPS_TRIAGE_MODEL') ?? judgeModel;
  const refusalFallbackModel = str('HEALOPS_REFUSAL_FALLBACK_MODEL') ?? `${prefix}claude-opus-4-8`;
  // used for judge/triage/screen when the fast model is not enabled on the account (403/404)
  const fastFallbackModel = str('HEALOPS_FAST_FALLBACK_MODEL') ?? `${prefix}claude-sonnet-5-5`;

  const surrealUrl = str('SURREAL_URL');
  const arizeKey = str('ARIZE_API_KEY');
  const arizeSpace = str('ARIZE_SPACE_ID');
  const autonomy = (str('HEALOPS_AUTONOMY') ?? 'auto_low') as Autonomy;

  cached = {
    root: ROOT,
    dataDir,
    artifactsDir: path.join(dataDir, 'artifacts'),
    serverPort: num('HEALOPS_SERVER_PORT', 8787),
    storePort: num('HEALOPS_STORE_PORT', 4000),
    publicApiUrl: str('HEALOPS_PUBLIC_API_URL') ?? `http://localhost:${num('HEALOPS_SERVER_PORT', 8787)}`,
    publicStoreUrl: str('HEALOPS_PUBLIC_STORE_URL')?.replace(/\/+$/, ''),
    autonomy: ['observe', 'suggest', 'auto_low', 'full'].includes(autonomy) ? autonomy : 'auto_low',
    riskThreshold: num('HEALOPS_RISK_THRESHOLD', 50),
    patrolIntervalSec: num('HEALOPS_PATROL_INTERVAL_SEC', 120),
    anchor: { enabled: Boolean(str('ANCHOR_API_KEY')), apiKey: str('ANCHOR_API_KEY') },
    daytona: {
      enabled: Boolean(str('DAYTONA_API_KEY')),
      apiKey: str('DAYTONA_API_KEY'),
      apiUrl: str('DAYTONA_API_URL'),
      target: str('DAYTONA_TARGET'),
    },
    aws: {
      enabled: awsEnabled,
      region: awsRegion,
      accessKeyId: str('AWS_ACCESS_KEY_ID'),
      secretAccessKey: str('AWS_SECRET_ACCESS_KEY'),
      sessionToken: str('AWS_SESSION_TOKEN'),
      s3Bucket: str('HEALOPS_S3_BUCKET'),
    },
    bedrock: {
      guardrailId: str('BEDROCK_GUARDRAIL_ID'),
      guardrailVersion: str('BEDROCK_GUARDRAIL_VERSION') ?? 'DRAFT',
      embedModel: str('HEALOPS_EMBED_MODEL') ?? 'amazon.titan-embed-text-v2:0',
    },
    anthropic: { enabled: Boolean(anthropicKey), apiKey: anthropicKey },
    llm: { provider, bedrockClient, patchModel, judgeModel, triageModel, refusalFallbackModel, fastFallbackModel },
    surreal: {
      enabled: Boolean(surrealUrl),
      url: surrealUrl,
      namespace: str('SURREAL_NAMESPACE') ?? 'healops',
      database: str('SURREAL_DATABASE') ?? 'agent',
      username: str('SURREAL_USER'),
      password: str('SURREAL_PASS'),
      // never treat a cloud PAT (sdbp_…) as a database token
      token: str('SURREAL_TOKEN')?.startsWith('sdbp_') ? undefined : str('SURREAL_TOKEN'),
      cloudToken: str('SURREAL_CLOUD_TOKEN') ?? (str('SURREAL_TOKEN')?.startsWith('sdbp_') ? str('SURREAL_TOKEN') : undefined),
    },
    arize: {
      enabled: Boolean(arizeKey && arizeSpace),
      spaceId: arizeSpace,
      apiKey: arizeKey,
      projectName: str('ARIZE_PROJECT_NAME') ?? 'healops',
      endpoint: str('ARIZE_OTLP_ENDPOINT') ?? 'https://otlp.arize.com/v1/traces',
    },
  };
  fs.mkdirSync(cached.artifactsDir, { recursive: true });
  return cached;
}

/** For tests: forget the cached config (after mutating process.env). */
export function resetConfigCache(): void {
  cached = undefined;
}
