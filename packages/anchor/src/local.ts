import fs from 'node:fs';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { VIEWPORT } from './common.js';

/**
 * Chromium to launch: HEALOPS_CHROMIUM_PATH if set, else Playwright's own download, else a
 * preinstalled build (Claude Code cloud ships one at /opt/pw-browsers/chromium that may not
 * match the playwright-core version).
 */
export function chromiumPath(): string | undefined {
  const override = process.env.HEALOPS_CHROMIUM_PATH?.trim();
  if (override) return override;
  try {
    if (fs.existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* no bundled build for this platform */
  }
  return ['/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p));
}

/** One headless Chromium shared by all local runs. Every run gets its own context. */
export class LocalChromium {
  private launching: Promise<Browser> | undefined;

  async newContext(): Promise<BrowserContext> {
    const browser = await this.browser();
    return browser.newContext({ viewport: VIEWPORT });
  }

  async close(): Promise<void> {
    const launching = this.launching;
    this.launching = undefined;
    if (!launching) return;
    const browser = await launching.catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  private browser(): Promise<Browser> {
    if (this.launching) return this.launching;
    const launch = chromium.launch({ headless: true, executablePath: chromiumPath() });
    this.launching = launch;
    // A browser that crashed or was closed is relaunched by the next run.
    launch.then(
      (browser) => {
        browser.on('disconnected', () => {
          if (this.launching === launch) this.launching = undefined;
        });
      },
      () => {
        if (this.launching === launch) this.launching = undefined;
      },
    );
    return launch;
  }
}
