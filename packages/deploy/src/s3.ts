import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import type { HealOpsConfig, SourceFile } from '@healops/shared';
import { emptyState, parseState, StoreDeployer, type DeployState } from './base.js';
import { contentTypeFor, isHtml, mapLimit, rewriteHtml } from './common.js';

/** Everything under this prefix is HealOps bookkeeping, not part of the public site. */
const RESERVED_PREFIX = '__healops/';
const STATE_KEY = `${RESERVED_PREFIX}state.json`;
const RELEASE_PREFIX = 'releases/';
/** Pristine copies of each release, so liveFiles() never returns the rewritten HTML. */
const SOURCE_PREFIX = `${RESERVED_PREFIX}src/`;
const NO_CACHE = 'no-cache';
const CONCURRENCY = 8;

function websiteUrl(bucket: string, region: string): string {
  return `http://${bucket}.s3-website-${region}.amazonaws.com`;
}

const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * S3 host. Each release is uploaded under releases/<version>/ with HTML already rewritten, which
 * is what the canary serves. The live version is copied to the bucket root.
 */
export class S3Deployer extends StoreDeployer {
  readonly provider = 'aws-s3' as const;
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly region: string;
  private readonly publicUrl: string | undefined;

  constructor(private readonly cfg: HealOpsConfig) {
    super();
    if (!cfg.aws.s3Bucket) throw new Error('the S3 deployer needs HEALOPS_S3_BUCKET');
    this.bucket = cfg.aws.s3Bucket;
    this.region = cfg.aws.region;
    this.publicUrl = cfg.publicStoreUrl?.replace(/\/+$/, '') || undefined;
    // Credentials come from the default provider chain (environment, profile, SSO, ...).
    this.s3 = new S3Client({ region: this.region });
  }

  liveUrl(): string {
    return this.publicUrl ?? websiteUrl(this.bucket, this.region);
  }

  protected canaryUrl(version: string): string {
    return `${this.liveUrl()}/${RELEASE_PREFIX}${version}`;
  }

  protected async readState(): Promise<DeployState> {
    const raw = await this.getText(STATE_KEY);
    return raw === undefined ? emptyState() : parseState(raw, `s3://${this.bucket}/${STATE_KEY}`);
  }

  protected async writeState(state: DeployState): Promise<void> {
    await this.put(STATE_KEY, `${JSON.stringify(state, null, 2)}\n`, 'application/json; charset=utf-8');
  }

  protected async writeRelease(version: string, files: SourceFile[]): Promise<void> {
    for (const file of files) {
      if (file.path.startsWith(RESERVED_PREFIX)) throw new Error(`${file.path} is reserved for HealOps state`);
    }
    await this.deleteKeys(await this.listKeys(`${RELEASE_PREFIX}${version}/`));
    await this.deleteKeys(await this.listKeys(`${SOURCE_PREFIX}${version}/`));
    await mapLimit(files, CONCURRENCY, async (file) => {
      const contentType = contentTypeFor(file.path);
      const served = isHtml(file.path) ? rewriteHtml(file.content, version, this.cfg.publicApiUrl) : file.content;
      await this.put(`${RELEASE_PREFIX}${version}/${file.path}`, served, contentType);
      await this.put(`${SOURCE_PREFIX}${version}/${file.path}`, file.content, contentType);
    });
  }

  protected async releaseExists(version: string): Promise<boolean> {
    const page = await this.s3.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `${RELEASE_PREFIX}${version}/`, MaxKeys: 1 }),
    );
    return (page.KeyCount ?? 0) > 0;
  }

  protected async readRelease(version: string): Promise<SourceFile[]> {
    const prefix = `${SOURCE_PREFIX}${version}/`;
    const keys = (await this.listKeys(prefix)).sort();
    if (keys.length === 0) throw new Error(`no source copy of release ${version} in s3://${this.bucket}`);
    return Promise.all(
      keys.map(async (key) => {
        const content = await this.getText(key);
        if (content === undefined) throw new Error(`${key} disappeared from s3://${this.bucket}`);
        return { path: key.slice(prefix.length), content };
      }),
    );
  }

  /**
   * Copy release `next` to the bucket root, then delete root objects the release does not have, so
   * the root mirrors the release exactly. Copying first keeps the site populated during the switch.
   */
  protected async activate(next: string): Promise<void> {
    const prefix = `${RELEASE_PREFIX}${next}/`;
    const keys = await this.listKeys(prefix);
    if (keys.length === 0) throw new Error(`release ${next} is missing from s3://${this.bucket}`);
    await mapLimit(keys, CONCURRENCY, async (key) => {
      await this.s3.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: key.slice(prefix.length),
          CopySource: `${this.bucket}/${encodeKey(key)}`,
          ContentType: contentTypeFor(key),
          CacheControl: NO_CACHE,
          MetadataDirective: 'REPLACE',
        }),
      );
    });
    const kept = new Set(keys.map((key) => key.slice(prefix.length)));
    const stale = (await this.listSiteKeys()).filter((key) => !kept.has(key));
    await this.deleteKeys(stale);
  }

  /** Keys of the public site at the bucket root: everything outside the release and reserved prefixes. */
  private async listSiteKeys(): Promise<string[]> {
    const keys = await this.listKeys('');
    return keys.filter((key) => !key.startsWith(RELEASE_PREFIX) && !key.startsWith(RESERVED_PREFIX));
  }

  protected async shutdown(): Promise<void> {
    this.s3.destroy();
  }

  private async getText(key: string): Promise<string | undefined> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return (await out.Body?.transformToString('utf8')) ?? '';
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  private async put(key: string, body: string, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: NO_CACHE,
      }),
    );
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key) keys.push(item.Key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }
}

/**
 * One-time setup of the bucket as a public static website. Creates the bucket if missing, turns
 * off Block Public Access, enables index.html hosting and applies a public-read policy.
 * Not called automatically; it touches real AWS resources.
 */
export async function provisionS3Site(cfg: HealOpsConfig): Promise<{ websiteUrl: string }> {
  const bucket = cfg.aws.s3Bucket;
  if (!bucket) throw new Error('HEALOPS_S3_BUCKET is not set');
  const region = cfg.aws.region;
  const s3 = new S3Client({ region });
  try {
    let exists = true;
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      exists = false;
    }
    if (!exists) {
      await s3.send(
        new CreateBucketCommand({
          Bucket: bucket,
          // us-east-1 rejects an explicit LocationConstraint.
          CreateBucketConfiguration:
            region === 'us-east-1' ? undefined : { LocationConstraint: region as BucketLocationConstraint },
        }),
      );
    }
    // Block Public Access must be off before a public-read policy is accepted.
    await s3.send(
      new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: false,
          IgnorePublicAcls: false,
          BlockPublicPolicy: false,
          RestrictPublicBuckets: false,
        },
      }),
    );
    await s3.send(
      new PutBucketWebsiteCommand({
        Bucket: bucket,
        WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' } },
      }),
    );
    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'HealOpsPublicRead',
              Effect: 'Allow',
              Principal: '*',
              Action: 's3:GetObject',
              Resource: `arn:aws:s3:::${bucket}/*`,
            },
          ],
        }),
      }),
    );
    return { websiteUrl: websiteUrl(bucket, region) };
  } finally {
    s3.destroy();
  }
}
