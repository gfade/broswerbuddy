import type { Deployer, SourceFile } from '@healops/shared';
import { assertVersion, normalizeFiles } from './common.js';

export interface HistoryEntry {
  version: string;
  at: number;
  note?: string;
}

/** The deploy state document: local deploy/state.json, S3 __healops/state.json. */
export interface DeployState {
  live?: string;
  /** Versions that were live before, most recent last. rollback() pops this. */
  previous: string[];
  /** Live transitions, oldest first. */
  history: HistoryEntry[];
}

export function emptyState(): DeployState {
  return { previous: [], history: [] };
}

export function parseState(raw: string, source: string): DeployState {
  let data: Partial<DeployState> | null;
  try {
    data = JSON.parse(raw) as Partial<DeployState> | null;
  } catch {
    throw new Error(`deploy state at ${source} is not valid JSON`);
  }
  const state = data ?? {};
  return {
    live: typeof state.live === 'string' && state.live !== '' ? state.live : undefined,
    previous: Array.isArray(state.previous) ? state.previous.filter((v): v is string => typeof v === 'string') : [],
    history: Array.isArray(state.history) ? state.history : [],
  };
}

/** Serialises mutations so concurrent calls in one process cannot interleave. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}

/**
 * The deploy lifecycle, shared by the local host and S3. Subclasses supply storage and serving;
 * the live / previous / history bookkeeping lives here so both providers behave identically.
 */
export abstract class StoreDeployer implements Deployer {
  abstract readonly provider: 'aws-s3' | 'local';
  private readonly mutex = new Mutex();

  abstract liveUrl(): string;

  /** Full URL where a staged (not yet live) version can be opened. */
  protected abstract canaryUrl(version: string): string;
  protected abstract readState(): Promise<DeployState>;
  protected abstract writeState(state: DeployState): Promise<void>;
  /** Replace release `version` with exactly `files` (already normalised). */
  protected abstract writeRelease(version: string, files: SourceFile[]): Promise<void>;
  protected abstract releaseExists(version: string): Promise<boolean>;
  /** Pristine (un-rewritten) files of a release. */
  protected abstract readRelease(version: string): Promise<SourceFile[]>;
  /** Make `next` what the public root serves. */
  protected abstract activate(next: string): Promise<void>;
  protected abstract shutdown(): Promise<void>;

  /** Runs before work that needs the store reachable. The local host starts its HTTP server here. */
  protected async prepare(): Promise<void> {}

  async bootstrap(files: SourceFile[], version: string): Promise<void> {
    assertVersion(version);
    const release = normalizeFiles(files);
    await this.prepare();
    await this.mutex.run(async () => {
      const state = await this.readState();
      if (state.live) return; // already hosting a version: leave it alone
      await this.writeRelease(version, release);
      await this.goLive(state, version, 'bootstrap');
    });
  }

  async currentVersion(): Promise<string> {
    return (await this.readState()).live ?? '';
  }

  async liveFiles(): Promise<SourceFile[]> {
    const { live } = await this.readState();
    return live ? this.readRelease(live) : [];
  }

  async stageCanary(version: string, files: SourceFile[]): Promise<{ canaryUrl: string }> {
    assertVersion(version);
    const release = normalizeFiles(files);
    await this.prepare();
    await this.mutex.run(async () => {
      if ((await this.readState()).live === version) {
        throw new Error(`refusing to stage ${version}: it is the live version`);
      }
      await this.writeRelease(version, release);
    });
    return { canaryUrl: this.canaryUrl(version) };
  }

  async promote(version: string): Promise<void> {
    assertVersion(version);
    await this.prepare();
    await this.mutex.run(async () => {
      const state = await this.readState();
      if (state.live === version) return;
      if (!(await this.releaseExists(version))) {
        throw new Error(`cannot promote ${version}: it has not been staged`);
      }
      if (state.live) state.previous.push(state.live);
      await this.goLive(state, version, 'promoted from canary');
    });
  }

  async rollback(): Promise<{ restoredVersion: string }> {
    await this.prepare();
    return this.mutex.run(async () => {
      const state = await this.readState();
      let target: string | undefined;
      do {
        target = state.previous.pop();
      } while (target !== undefined && target === state.live);
      if (target === undefined) {
        throw new Error('nothing to roll back to: no previous live version is recorded');
      }
      if (!(await this.releaseExists(target))) {
        throw new Error(`cannot roll back to ${target}: its release is missing`);
      }
      await this.goLive(state, target, `rollback from ${state.live ?? 'nothing'}`);
      return { restoredVersion: target };
    });
  }

  async publish(files: SourceFile[], version: string, note?: string): Promise<void> {
    assertVersion(version);
    const release = normalizeFiles(files);
    await this.prepare();
    await this.mutex.run(async () => {
      const state = await this.readState();
      await this.writeRelease(version, release);
      if (state.live && state.live !== version) state.previous.push(state.live);
      await this.goLive(state, version, note ?? 'publish');
    });
  }

  async history(): Promise<{ version: string; at: number; note?: string }[]> {
    return (await this.readState()).history.map((entry) => ({ ...entry })).reverse();
  }

  async close(): Promise<void> {
    await this.mutex.idle();
    await this.shutdown();
  }

  /** Activate `version` for serving, record the change, and persist state last. */
  private async goLive(state: DeployState, version: string, note: string): Promise<void> {
    await this.activate(version);
    state.live = version;
    state.history.push({ version, at: Date.now(), note });
    await this.writeState(state);
  }
}
