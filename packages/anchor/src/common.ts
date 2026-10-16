/** Viewport for every browser context, local and Anchor. */
export const VIEWPORT = { width: 1280, height: 800 };

/**
 * Sent on every request a flow's browser context makes. HealOps runs flows against Daytona sandbox
 * preview URLs; without this header Daytona serves a preview-warning interstitial instead of the site.
 */
export const EXTRA_HEADERS: Record<string, string> = { 'X-Daytona-Skip-Preview-Warning': 'true' };

/**
 * Rejects if `work` has not settled within `ms`. A result that arrives after the timeout is handed to
 * `onLate`, so a session created after we gave up can still be ended.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string, onLate?: (value: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gaveUp = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      gaveUp = true;
      reject(new Error(`${what} timed out after ${ms} ms`));
    }, ms);
  });
  work.then(
    (value) => {
      if (gaveUp) onLate?.(value);
    },
    () => undefined,
  );
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Strips API keys and connection tokens from text before it is logged. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text.replace(/([?&](?:apiKey|rt|token)=)[^&\s'")]+/gi, '$1<redacted>');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  return out;
}
