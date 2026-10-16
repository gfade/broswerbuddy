import type {
  BrowserRunner, BugSeed, Deployer, EventBus, FlowDefinition, HealOpsConfig, LLM, Memory,
  SandboxProvider, SourceFile, Telemetry,
} from '@healops/shared';

/** Describes the target app: healthy source, how to test it, and the bugs that can be injected. */
export interface SiteProvider {
  /** initial store version, e.g. '1.4.2' */
  version: string;
  /** healthy site files */
  loadSite(): SourceFile[];
  /** sandbox layout: site/**, tests/**, package.json */
  sandboxFiles(site: SourceFile[], extra?: SourceFile[]): SourceFile[];
  /** e.g. 'node --test tests/' */
  testCommand: string;
  seeds: BugSeed[];
  applySeed(files: SourceFile[], seedId: string): SourceFile[];
  /** seed applied at first bootstrap (store goes live WITH a bug) */
  defaultSeed?: string;
}

/** Everything the runtime needs. Adapters are injected; the agent never imports them. */
export interface RuntimeDeps {
  config: HealOpsConfig;
  llm: LLM;
  browser: BrowserRunner;
  sandboxes: SandboxProvider;
  memory: Memory;
  telemetry: Telemetry;
  deployer: Deployer;
  site: SiteProvider;
  flows: FlowDefinition[];
  seedHistory?: (memory: Memory, embed: (t: string) => Promise<number[]>) => Promise<number>;
  bus?: EventBus;
}
