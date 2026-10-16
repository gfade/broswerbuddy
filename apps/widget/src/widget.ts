/**
 * "🐞 Bugs?" widget entry point. Loaded as:
 *   <script src=".../widget/healops.js" data-endpoint="https://heal.example.com" defer></script>
 */
import { start as startCapture } from './capture';
import { createWidget } from './ui';

interface HealOpsGlobal {
  readonly version: string;
  open(): void;
  close(): void;
}

/** Reports go to data-endpoint on this script tag, else to the script's own origin. */
function resolveEndpoint(): string {
  const script =
    (document.currentScript as HTMLScriptElement | null) ??
    document.querySelector<HTMLScriptElement>('script[src*="healops.js"]');
  let endpoint = script?.dataset.endpoint ?? '';
  if (!endpoint && script?.src) {
    try {
      endpoint = new URL(script.src).origin;
    } catch {
      /* malformed src: fall back to the page origin */
    }
  }
  return (endpoint || location.origin).replace(/\/+$/, '');
}

function main(): void {
  const w = window as Window & { HealOps?: HealOpsGlobal };
  if (w.HealOps) return; // already loaded

  // currentScript is only valid while this script runs, so read it synchronously here.
  const endpoint = resolveEndpoint();
  let widget: ReturnType<typeof createWidget> | undefined;
  startCapture(() => widget?.pulse());
  widget = createWidget(endpoint);

  w.HealOps = {
    version: '0.1.0',
    open: () => widget?.open(),
    close: () => widget?.close(),
  };
}

main();
