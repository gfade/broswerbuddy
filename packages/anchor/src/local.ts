import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { VIEWPORT } from './common.js';

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
    const launch = chromium.launch({ headless: true });
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
