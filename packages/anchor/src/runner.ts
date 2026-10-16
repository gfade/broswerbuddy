import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import {
  createLogger,
  errorMessage,
  isLocalUrl,
  loadConfig,
  type BrowserRunner,
  type FlowContext,
  type FlowDefinition,
  type FlowRunResult,
  type FlowStepResult,
  type HealOpsConfig,
  type RunFlowOptions,
} from '@healops/shared';
import { AnchorSessions, type AnchorSession } from './anchor.js';
import { EXTRA_HEADERS, VIEWPORT } from './common.js';
import { LocalChromium } from './local.js';

const log = createLogger('anchor');

const DEFAULT_FLOW_TIMEOUT_MS = 45_000;
const PAGE_TIMEOUT_MS = 8_000;
const SCREENSHOT_TIMEOUT_MS = 10_000;

type SessionInfo = Parameters<NonNullable<RunFlowOptions['onSession']>>[0];

/** The browser one run executes in, and how to release it. */
interface RunTarget {
  provider: 'anchor' | 'local';
  page: Page;
  sessionId?: string;
  liveViewUrl?: string;
  /** Releases the browser and, for Anchor, ends the session. Must not throw on the happy path. */
  teardown(): Promise<void>;
}

/** What the flow body produced. runFlowBody never throws. */
interface Attempt {
  steps: FlowStepResult[];
  threw: boolean;
  flowError?: unknown;
  failedStep?: number;
  consoleErrors: string[];
  pageErrors: string[];
}

/**
 * Runs flows in an Anchor Browser cloud session when Anchor is configured and the target is public.
 * Otherwise (or when a session cannot be created) it runs them in a local headless Chromium.
 */
export function createBrowserRunner(cfg: HealOpsConfig = loadConfig()): BrowserRunner {
  const sessions = cfg.anchor.enabled && cfg.anchor.apiKey ? new AnchorSessions(cfg.anchor.apiKey) : undefined;
  const local = new LocalChromium();

  return {
    provider: sessions ? 'anchor' : 'local',
    runFlow: (flow, opts) => runOnce(flow, opts, sessions, local),
    close: async () => {
      await Promise.allSettled([sessions?.closeAll(), local.close()]);
    },
  };
}

async function runOnce(
  flow: FlowDefinition,
  opts: RunFlowOptions,
  sessions: AnchorSessions | undefined,
  local: LocalChromium,
): Promise<FlowRunResult> {
  const startedAt = Date.now();
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;

  let target: RunTarget | undefined;
  if (sessions && !opts.forceLocal && !isLocalUrl(baseUrl)) {
    target = await openAnchor(sessions, flow, opts);
  }
  if (!target) {
    safeCall('onSession', () => opts.onSession?.({ provider: 'local' }));
    try {
      target = await openLocal(local);
    } catch (err) {
      return setupFailure(flow, baseUrl, startedAt, `browser setup failed: ${errorMessage(err)}`);
    }
  }

  const { provider, page } = target;
  const flowStartedAt = Date.now();
  let flowMs = 0;
  let attempt: Attempt;
  let screenshotFile: string | undefined;
  try {
    attempt = await runFlowBody(flow, page, baseUrl, opts, timeoutMs);
    flowMs = Date.now() - flowStartedAt;
    screenshotFile = await takeScreenshot(page, flow.id, opts.artifactsDir);
  } catch (err) {
    // runFlowBody and takeScreenshot do not throw; this only guards against a bug in the runner.
    attempt = { steps: [], threw: true, flowError: err, consoleErrors: [], pageErrors: [] };
  } finally {
    await teardownQuietly(target);
  }
  if (provider === 'anchor') {
    log.info(`flow ${flow.id} ran in ${flowMs} ms (${attempt.threw ? 'failed' : 'ok'})`);
  }

  return {
    flowId: flow.id,
    ok: !attempt.threw,
    baseUrl,
    provider,
    steps: attempt.steps,
    failedStep: attempt.failedStep,
    error: buildError(attempt),
    consoleErrors: attempt.consoleErrors,
    pageErrors: attempt.pageErrors,
    screenshotFile,
    sessionId: target.sessionId,
    liveViewUrl: target.liveViewUrl,
    startedAt,
    durationMs: Date.now() - startedAt,
  };
}

/** Creates an Anchor session and connects to it. Returns undefined (after logging why) if that fails. */
async function openAnchor(
  sessions: AnchorSessions,
  flow: FlowDefinition,
  opts: RunFlowOptions,
): Promise<RunTarget | undefined> {
  const createdAt = Date.now();
  let session: AnchorSession;
  try {
    session = await sessions.createSession(['healops', `flow:${flow.id}`]);
  } catch (err) {
    fallBack(flow, sessions.redact(errorMessage(err)));
    return undefined;
  }
  const { id, liveViewUrl } = session;
  log.info(`session ${id} created in ${Date.now() - createdAt} ms`);
  // Fired as soon as the session exists, so the dashboard can embed the live view while the flow runs.
  safeCall('onSession', () => opts.onSession?.({ provider: 'anchor', sessionId: id, liveViewUrl }));

  let attached: { browser: Browser; page: Page };
  try {
    attached = await attach(sessions, session.cdpUrl);
  } catch (err) {
    await sessions.endSession(id);
    fallBack(flow, sessions.redact(errorMessage(err)));
    return undefined;
  }
  const { browser, page } = attached;
  return {
    provider: 'anchor',
    page,
    sessionId: id,
    liveViewUrl,
    teardown: async () => {
      const closeStarted = Date.now();
      await browser.close().catch(() => undefined);
      const deleteStarted = Date.now();
      await sessions.endSession(id);
      log.info(
        `session ${id} ended: disconnect ${deleteStarted - closeStarted} ms, delete ${Date.now() - deleteStarted} ms`,
      );
    },
  };
}

/** Connects over CDP and returns the session's default page, with the Daytona header set on its context. */
async function attach(sessions: AnchorSessions, cdpUrl: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await sessions.connect(cdpUrl);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext({ viewport: VIEWPORT }));
    await context.setExtraHTTPHeaders(EXTRA_HEADERS);
    const page = context.pages()[0] ?? (await context.newPage());
    return { browser, page };
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}

/** A fresh context on the shared local browser, with the Daytona header set. */
async function openLocal(local: LocalChromium): Promise<RunTarget> {
  const context: BrowserContext = await local.newContext();
  try {
    await context.setExtraHTTPHeaders(EXTRA_HEADERS);
    const page = await context.newPage();
    return {
      provider: 'local',
      page,
      teardown: async () => {
        await context.close().catch(() => undefined);
      },
    };
  } catch (err) {
    await context.close().catch(() => undefined);
    throw err;
  }
}

/** Runs the flow body with step recording, console and page-error capture, and the overall timeout. */
async function runFlowBody(
  flow: FlowDefinition,
  page: Page,
  baseUrl: string,
  opts: RunFlowOptions,
  timeoutMs: number,
): Promise<Attempt> {
  const steps: FlowStepResult[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failures: { index: number; error: unknown }[] = [];
  const running = new Map<number, { name: string; startedAt: number }>();
  let nextIndex = 0;
  // Set once the flow has ended or timed out. Late step results after that are dropped.
  let closed = false;

  const record = (step: FlowStepResult): void => {
    steps.push(step);
    safeCall('onStep', () => opts.onStep?.(step));
  };

  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.stack ?? err.message);
  });

  const ctx: FlowContext = {
    page,
    baseUrl,
    step: async (name, fn) => {
      const index = nextIndex++;
      const startedAt = Date.now();
      running.set(index, { name, startedAt });
      try {
        await fn();
        running.delete(index);
        if (!closed) record({ index, name, ok: true, durationMs: Date.now() - startedAt });
      } catch (err) {
        running.delete(index);
        if (!closed) {
          failures.push({ index, error: err });
          record({ index, name, ok: false, durationMs: Date.now() - startedAt, error: errorMessage(err) });
        }
        throw err;
      }
    },
  };

  const timeoutError = new Error(`flow "${flow.id}" timed out after ${timeoutMs} ms`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      closed = true;
      // Steps still in flight count as failed at the point the timeout hit.
      for (const [index, info] of running) {
        failures.push({ index, error: timeoutError });
        record({
          index,
          name: info.name,
          ok: false,
          durationMs: Date.now() - info.startedAt,
          error: timeoutError.message,
        });
      }
      running.clear();
      reject(timeoutError);
    }, timeoutMs);
  });

  let threw = false;
  let flowError: unknown;
  try {
    await Promise.race([(async () => flow.run(ctx))(), deadline]);
  } catch (err) {
    threw = true;
    flowError = err;
  } finally {
    clearTimeout(timer);
    closed = true;
  }

  // The failed step is the one whose error ended the flow; otherwise the last step that failed.
  const failure = threw ? (failures.find((f) => f.error === flowError) ?? failures[failures.length - 1]) : undefined;
  return {
    steps: [...steps].sort((a, b) => a.index - b.index),
    threw,
    flowError,
    failedStep: failure?.index,
    consoleErrors: [...consoleErrors],
    pageErrors: [...pageErrors],
  };
}

/**
 * Error for a failed run. When the page threw an uncaught error, that error is the root cause, so it
 * leads the message and supplies the stack; the Playwright error follows as context.
 */
function buildError(attempt: Attempt): FlowRunResult['error'] {
  if (!attempt.threw) return undefined;
  const flowText = errorMessage(attempt.flowError);
  const root = attempt.pageErrors[0];
  if (root === undefined) {
    const stack = attempt.flowError instanceof Error ? attempt.flowError.stack : undefined;
    return { message: flowText, stack };
  }
  return { message: `${root.split('\n')[0]} (flow: ${flowText.split('\n')[0]})`, stack: root };
}

async function takeScreenshot(page: Page, flowId: string, artifactsDir: string): Promise<string | undefined> {
  try {
    const dir = path.resolve(artifactsDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${flowId.replace(/[^\w.-]/g, '_')}-${Date.now()}.png`);
    await page.screenshot({ path: file, timeout: SCREENSHOT_TIMEOUT_MS });
    return file;
  } catch (err) {
    log.warn(`screenshot failed: ${errorMessage(err)}`);
    return undefined;
  }
}

async function teardownQuietly(target: RunTarget): Promise<void> {
  try {
    await target.teardown();
  } catch (err) {
    log.warn(`teardown failed: ${errorMessage(err)}`);
  }
}

function setupFailure(flow: FlowDefinition, baseUrl: string, startedAt: number, message: string): FlowRunResult {
  return {
    flowId: flow.id,
    ok: false,
    baseUrl,
    provider: 'local',
    steps: [],
    error: { message },
    consoleErrors: [],
    pageErrors: [],
    startedAt,
    durationMs: Date.now() - startedAt,
  };
}

function fallBack(flow: FlowDefinition, reason: string): void {
  log.warn(`Anchor unavailable, running ${flow.id} locally: ${reason}`);
}

/** Calls a caller-supplied callback without letting its exceptions break the run. */
function safeCall(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.warn(`${label} callback threw: ${errorMessage(err)}`);
  }
}
