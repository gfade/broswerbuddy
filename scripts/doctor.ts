/**
 * `npm run doctor`: checks every sponsor credential with the cheapest real call and
 * prints one table, then the modes the app will actually run in.
 *
 * Each check runs under a 20s timeout and cannot crash the script. Secret values are
 * never printed; error text is scrubbed of them before it is shown. Each third-party
 * SDK is imported inside its own check, so a broken install fails one row, not the run.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Surreal } from 'surrealdb';
import { loadConfig, type HealOpsConfig } from '@healops/shared';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { HeadBucketCommand, ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

const TIMEOUT_MS = 20_000;
const cfg: HealOpsConfig = loadConfig();
const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');

// ---- result model ----------------------------------------------------------------

type Status = 'ok' | 'fail' | 'skip';

interface Row {
  name: string;
  status: Status;
  detail: string;
  ms: number;
}

/** A check that does not apply to this configuration. The reason is shown instead of a detail. */
class Skipped {
  constructor(readonly reason: string) {}
}
const skip = (reason: string): Skipped => new Skipped(reason);

const N = {
  aws: 'AWS identity (STS)',
  claudePatch: 'Bedrock Claude · patch',
  claudeJudge: 'Bedrock Claude · judge',
  embed: 'Bedrock embeddings',
  guard: 'Bedrock guardrail',
  s3List: 'S3 list buckets',
  s3Bucket: 'S3 bucket',
  anchor: 'Anchor browser',
  daytona: 'Daytona sandboxes',
  surreal: 'SurrealDB',
  surrealCloud: 'SurrealDB Cloud instances',
  arize: 'Arize',
  node: 'Node.js',
  chromium: 'Playwright chromium',
  cloudflared: 'cloudflared',
} as const;

// ---- secret scrubbing --------------------------------------------------------------

// Longest first, so a value that contains a shorter one is scrubbed whole.
const SECRETS = [
  cfg.anchor.apiKey,
  cfg.daytona.apiKey,
  cfg.aws.accessKeyId,
  cfg.aws.secretAccessKey,
  cfg.aws.sessionToken,
  cfg.anthropic.apiKey,
  cfg.arize.apiKey,
  cfg.surreal.password,
  cfg.surreal.token,
  cfg.surreal.cloudToken,
]
  .filter((s): s is string => typeof s === 'string' && s.length >= 6)
  .sort((a, b) => b.length - a.length);

function scrub(text: string): string {
  return SECRETS.reduce((t, secret) => t.split(secret).join('[redacted]'), text);
}

function describe(err: unknown): string {
  let msg: string;
  if (err instanceof Error) {
    msg = err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
    if (err.cause instanceof Error) msg += ` (${err.cause.message})`;
  } else if (typeof err === 'string') {
    msg = err;
  } else {
    try {
      msg = JSON.stringify(err) ?? String(err);
    } catch {
      msg = String(err);
    }
  }
  msg = scrub(msg).replace(/\s+/g, ' ').trim();
  return msg.length > 240 ? `${msg.slice(0, 237)}...` : msg;
}

// ---- runner ------------------------------------------------------------------------

async function check(name: string, fn: () => Promise<string | Skipped>): Promise<Row> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([fn(), timeout]);
    const ms = Math.round(performance.now() - started);
    return outcome instanceof Skipped
      ? { name, status: 'skip', detail: outcome.reason, ms }
      : { name, status: 'ok', detail: outcome, ms };
  } catch (err) {
    return { name, status: 'fail', detail: describe(err), ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a local binary and resolves with its stdout. Extra env is merged over the process env. */
function run(file: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: { ...process.env, ...extraEnv }, timeout: TIMEOUT_MS - 2_000, windowsHide: true, maxBuffer: 1 << 20 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

// ---- AWS ---------------------------------------------------------------------------

async function awsIdentity(): Promise<string> {
  const out = await new STSClient({ region: cfg.aws.region }).send(new GetCallerIdentityCommand({}));
  const session = cfg.aws.sessionToken ? ' (temporary session credentials)' : '';
  return `${out.Arn ?? 'no ARN returned'}${session}`;
}

async function s3List(): Promise<string> {
  const out = await new S3Client({ region: cfg.aws.region }).send(new ListBucketsCommand({}));
  return `${out.Buckets?.length ?? 0} bucket(s) visible`;
}

async function s3Bucket(): Promise<string | Skipped> {
  const bucket = cfg.aws.s3Bucket;
  if (!bucket) return skip('HEALOPS_S3_BUCKET not set');
  await new S3Client({ region: cfg.aws.region }).send(new HeadBucketCommand({ Bucket: bucket }));
  return `${bucket} reachable`;
}

// ---- Bedrock -----------------------------------------------------------------------

/** Anthropic models through the Bedrock runtime client (cross-region inference profiles). */
async function claude(model: string): Promise<string> {
  const { default: AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk');
  const client = new AnthropicBedrock({ awsRegion: cfg.aws.region });
  const msg = await client.messages.create({
    model,
    max_tokens: 256,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  });
  const stop = msg.stop_reason ?? 'none';
  for (const block of msg.content) {
    if (block.type === 'text') return `${model} · stop_reason=${stop} · reply "${block.text.trim().slice(0, 40)}"`;
  }
  throw new Error(`no text block in the reply (stop_reason=${stop})`);
}

async function embeddings(): Promise<string> {
  const runtime = new BedrockRuntimeClient({ region: cfg.aws.region });
  const res = await runtime.send(
    new InvokeModelCommand({
      modelId: cfg.bedrock.embedModel,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: 'healops doctor ping', dimensions: 256, normalize: true }),
    }),
  );
  const json = JSON.parse(new TextDecoder().decode(res.body)) as { embedding?: unknown };
  if (!Array.isArray(json.embedding)) throw new Error('response has no embedding array');
  return `${cfg.bedrock.embedModel} · dims=${json.embedding.length}`;
}

async function guardrail(): Promise<string | Skipped> {
  const id = cfg.bedrock.guardrailId;
  if (!id) return skip('not configured (Claude classifier screens input)');
  const runtime = new BedrockRuntimeClient({ region: cfg.aws.region });
  const res = await runtime.send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: id,
      guardrailVersion: cfg.bedrock.guardrailVersion,
      source: 'INPUT',
      content: [{ text: { text: 'Hello, can you summarize the checkout page for me?' } }],
    }),
  );
  if (res.action !== 'NONE') throw new Error(`benign text was ${res.action}; review the guardrail filters`);
  return `${id} (${cfg.bedrock.guardrailVersion}) · action=NONE on benign text`;
}

// ---- Anchor ------------------------------------------------------------------------

interface BillingFields {
  tier?: string;
  credits?: number;
  credits_used?: number;
  billing_period?: string;
}

async function anchor(): Promise<string | Skipped> {
  const key = cfg.anchor.apiKey;
  if (!key) return skip('ANCHOR_API_KEY not set');
  const { Billing, client } = await import('anchorbrowser');
  client.setConfig({ auth: key });
  // Read-only: GET /v1/billing. No browser session is created. The SDK types this response
  // as { data: {...} }, but the fields come back unwrapped, so accept either shape.
  const raw: unknown = await Billing.getBilling();
  const body = raw as BillingFields & { data?: BillingFields };
  const info = body.data ?? body;
  if (typeof info.credits !== 'number') throw new Error('billing response had no credit balance');
  return `GET /v1/billing · tier ${info.tier ?? '?'} · ${info.credits} credits left, ${info.credits_used ?? 0} used (${info.billing_period ?? '?'})`;
}

// ---- Daytona -----------------------------------------------------------------------

async function daytona(): Promise<string | Skipped> {
  const key = cfg.daytona.apiKey;
  if (!key) return skip('DAYTONA_API_KEY not set');
  const { Daytona } = await import('@daytonaio/sdk');
  const client = new Daytona({ apiKey: key, apiUrl: cfg.daytona.apiUrl, target: cfg.daytona.target });
  let count = 0;
  for await (const _sandbox of client.list()) count += 1;
  const host = cfg.daytona.apiUrl ? new URL(cfg.daytona.apiUrl).host : 'default endpoint';
  return `${count} sandbox(es) · ${host} · target ${cfg.daytona.target ?? 'default'}`;
}

// ---- SurrealDB ---------------------------------------------------------------------

async function expectOne(db: Surreal): Promise<void> {
  const [one] = await db.query('RETURN 1').collect<[number]>();
  if (one !== 1) throw new Error(`RETURN 1 returned ${JSON.stringify(one)}`);
}

async function surrealDb(): Promise<string> {
  const { namespace, database, url } = cfg.surreal;
  const { Surreal: SurrealClient } = await import('surrealdb');
  if (url) {
    const db = new SurrealClient();
    const { username, password, token } = cfg.surreal;
    const authentication = token ?? (username && password ? { username, password } : undefined);
    try {
      await db.connect(url, { namespace, database, authentication });
      await expectOne(db);
      return `remote ${new URL(url).host} · ${namespace}/${database} · RETURN 1 = 1`;
    } finally {
      await db.close().catch(() => undefined);
    }
  }
  const { createNodeEngines } = await import('@surrealdb/node');
  const db = new SurrealClient({ engines: createNodeEngines() });
  try {
    await db.connect('mem://', { namespace, database });
    await expectOne(db);
    return 'embedded (mem://) · RETURN 1 = 1 · SURREAL_URL not set';
  } finally {
    await db.close().catch(() => undefined);
  }
}

async function surrealCloud(): Promise<string | Skipped> {
  const token = cfg.surreal.cloudToken;
  if (!token) return skip('SURREAL_CLOUD_TOKEN not set');
  const exe = path.join(localAppData, 'SurrealDB', 'surreal.exe');
  if (!fs.existsSync(exe)) return skip('surreal.exe not installed (optional)');
  const stdout = await run(exe, ['cloud', 'instance', 'list', '--json'], { SURREAL_CLOUD_TOKEN: token });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('unexpected output from surreal cloud instance list');
  if (parsed.length === 0) {
    throw new Error(
      '0 instances · create a free instance in Surreal Cloud (region aws-usw2), then set SURREAL_URL / SURREAL_USER / SURREAL_PASS in .env',
    );
  }
  return `${parsed.length} instance(s) in Surreal Cloud`;
}

// ---- Arize -------------------------------------------------------------------------

const ARIZE_QUERY =
  'query { account { organizations(first: 3) { edges { node { name spaces(first: 10) { edges { node { id name } } } } } } } }';

interface ArizeReply {
  data?: {
    account?: {
      organizations?: {
        edges: { node: { name: string; spaces?: { edges: { node: { id: string; name: string } }[] } } }[];
      };
    };
  };
  errors?: { message: string }[];
}

async function arize(): Promise<string | Skipped> {
  const { apiKey, spaceId } = cfg.arize;
  if (!apiKey) return skip('ARIZE_API_KEY not set (tracing off)');
  if (!spaceId) return skip('ARIZE_SPACE_ID not set (tracing off)');
  const res = await fetch('https://app.arize.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ query: ARIZE_QUERY }),
    signal: AbortSignal.timeout(TIMEOUT_MS - 1_000),
  });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (check ARIZE_API_KEY)' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const reply = (await res.json()) as ArizeReply;
  if (reply.errors?.length) throw new Error(reply.errors.map((e) => e.message).join('; '));
  let seen = 0;
  for (const { node: org } of reply.data?.account?.organizations?.edges ?? []) {
    for (const { node: space } of org.spaces?.edges ?? []) {
      seen += 1;
      if (space.id === spaceId) return `space "${space.name}" (org "${org.name}")`;
    }
  }
  throw new Error(`ARIZE_SPACE_ID is not among the ${seen} space(s) this key can see`);
}

// ---- local tools -------------------------------------------------------------------

function nodeCheck(): string {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) throw new Error(`${process.version} is older than the required >=22`);
  return process.version;
}

async function chromiumCheck(): Promise<string> {
  const { chromium } = await import('playwright-core');
  const exe = chromium.executablePath();
  if (!fs.existsSync(exe)) throw new Error('not installed; run npm run browsers');
  return `installed (${exe.split(/[\\/]/).slice(-3).join('/')})`;
}

/** Same lookup order as scripts/tunnel.mjs: PATH, then the WinGet link, then the WinGet package. */
function findCloudflared(): string | undefined {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  const link = path.join(localAppData, 'Microsoft', 'WinGet', 'Links', exe);
  if (fs.existsSync(link)) return link;
  const packages = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const pkg of fs.readdirSync(packages)) {
      if (!pkg.startsWith('Cloudflare.cloudflared')) continue;
      const hit = findFile(path.join(packages, pkg), exe, 2);
      if (hit) return hit;
    }
  } catch {
    // no WinGet package directory
  }
  return undefined;
}

function findFile(dir: string, name: string, depth: number): string | undefined {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return full;
    if (entry.isDirectory() && depth > 0) {
      const hit = findFile(full, name, depth - 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

async function cloudflaredCheck(): Promise<string> {
  const bin = findCloudflared();
  if (!bin) throw new Error('not found; install with: winget install --id Cloudflare.cloudflared');
  const version = (await run(bin, ['--version'])).trim().split(/\r?\n/)[0];
  return version || 'installed';
}

// ---- output ------------------------------------------------------------------------

function renderTable(rows: Row[]): string {
  const nameW = Math.max(...rows.map((r) => r.name.length));
  const detailW = Math.max(...rows.map((r) => r.detail.length));
  const icon: Record<Status, string> = { ok: '✓', fail: '✗', skip: '–' };
  const lines = [`  ${'Check'.padEnd(nameW)}  ${'Detail'.padEnd(detailW)}  Latency`];
  lines.push(`  ${'-'.repeat(nameW)}  ${'-'.repeat(detailW)}  -------`);
  for (const r of rows) {
    const latency = r.status === 'skip' ? '' : `${r.ms} ms`;
    lines.push(`${icon[r.status]} ${r.name.padEnd(nameW)}  ${r.detail.padEnd(detailW)}  ${latency.padStart(7)}`);
  }
  return lines.join('\n');
}

/** What the app will actually run in, derived from the check results. */
function runModes(rows: Row[]): string[] {
  const byName = new Map(rows.map((r) => [r.name, r] as const));
  const ok = (name: string): boolean => byName.get(name)?.status === 'ok';
  const failed = (name: string): boolean => byName.get(name)?.status === 'fail';
  const detail = (name: string): string => byName.get(name)?.detail ?? '';

  const patch = ok(N.claudePatch);
  const judge = ok(N.claudeJudge);
  const llm =
    patch && judge
      ? `live · Bedrock ${cfg.llm.patchModel} / ${cfg.llm.judgeModel}`
      : `${patch || judge ? 'partial' : 'degraded'} · patch ${patch ? 'live' : 'failing'}, judge ${judge ? 'live' : 'failing'}`;
  const modes: [string, string][] = [
    ['LLM (patch / judge)', llm],
    ['Embeddings', ok(N.embed) ? `live · Bedrock ${cfg.bedrock.embedModel}` : 'unavailable · Bedrock embeddings failing'],
    [
      'Input screening',
      ok(N.guard)
        ? `Bedrock guardrail ${cfg.bedrock.guardrailId}`
        : failed(N.guard)
          ? 'Claude classifier · guardrail check failing'
          : 'Claude classifier · no guardrail configured',
    ],
    [
      'Browser',
      ok(N.anchor)
        ? 'live · Anchor cloud browser'
        : ok(N.chromium)
          ? 'local · Playwright chromium'
          : 'unavailable · no Anchor and no local chromium',
    ],
    [
      'Sandboxes',
      ok(N.daytona) ? `live · Daytona (target ${cfg.daytona.target ?? 'default'})` : 'local · Daytona not verified',
    ],
    [
      'Memory',
      ok(N.surreal)
        ? cfg.surreal.url
          ? 'live · SurrealDB remote'
          : 'embedded · mem:// (in-process)'
        : 'unavailable · SurrealDB check failing',
    ],
    [
      'Telemetry',
      ok(N.arize)
        ? `live · Arize ${detail(N.arize)}`
        : failed(N.arize)
          ? 'off · Arize check failing'
          : 'off · Arize not configured',
    ],
    [
      'Store hosting',
      ok(N.s3Bucket) ? `S3 bucket ${cfg.aws.s3Bucket}` : 'local · store on localhost, public URL via npm run tunnel',
    ],
    [
      'Public URLs',
      ok(N.cloudflared) ? 'npm run tunnel (cloudflared found)' : 'unavailable · install cloudflared',
    ],
  ];
  const width = Math.max(...modes.map(([label]) => label.length));
  return modes.map(([label, text]) => `  ${label.padEnd(width)}  ${text}`);
}

async function main(): Promise<void> {
  const rows = await Promise.all([
    check(N.aws, awsIdentity),
    check(N.claudePatch, () => claude(cfg.llm.patchModel)),
    check(N.claudeJudge, () => claude(cfg.llm.judgeModel)),
    check(N.embed, embeddings),
    check(N.guard, guardrail),
    check(N.s3List, s3List),
    check(N.s3Bucket, s3Bucket),
    check(N.anchor, anchor),
    check(N.daytona, daytona),
    check(N.surreal, surrealDb),
    check(N.surrealCloud, surrealCloud),
    check(N.arize, arize),
    check(N.node, async () => nodeCheck()),
    check(N.chromium, chromiumCheck),
    check(N.cloudflared, cloudflaredCheck),
  ]);

  const passed = rows.filter((r) => r.status === 'ok').length;
  const failedCount = rows.filter((r) => r.status === 'fail').length;
  const skipped = rows.length - passed - failedCount;
  const text = [
    `HealOps doctor · region ${cfg.aws.region} · Node ${process.version}`,
    '',
    renderTable(rows),
    '',
    'Run modes',
    ...runModes(rows),
    '',
    `Summary: ${passed} passed · ${failedCount} failed · ${skipped} skipped`,
  ].join('\n');
  process.stdout.write(`${text}\n`, () => process.exit(failedCount > 0 ? 1 : 0));
}

main().catch((err: unknown) => {
  process.stderr.write(`doctor: ${describe(err)}\n`, () => process.exit(1));
});
