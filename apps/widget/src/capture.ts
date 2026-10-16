import type { CapturedEvent } from './types';

const MAX_EVENTS = 50;
const MAX_ERRORS = 20;
const MAX_MESSAGE = 2000;
const EVENT_TYPES = ['click', 'input', 'submit', 'change'] as const;
/** Snap a target to the element a person would call "the button", not the span inside it. */
const INTERACTIVE = '[data-testid],button,a,input,select,textarea,label,[role]';

const events: CapturedEvent[] = [];
const errors: string[] = [];
let notify: (() => void) | undefined;

/** Short, value-free descriptor: `button[data-testid=pay-now]` or `tag#id.class`. */
function targetOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const testId = el.getAttribute('data-testid');
  if (testId) return `${tag}[data-testid=${testId}]`.slice(0, 120);
  const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2);
  return `${tag}${el.id ? '#' + el.id : ''}${classes.map((c) => '.' + c).join('')}`.slice(0, 120);
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (v instanceof Element) return targetOf(v);
  if (typeof v === 'object' && v !== null) {
    try {
      return (JSON.stringify(v) as string | undefined) ?? String(v);
    } catch {
      /* circular or hostile object: fall through */
    }
  }
  try {
    return String(v);
  } catch {
    return '[unprintable]';
  }
}

function pushError(message: string): void {
  errors.push(message.length > MAX_MESSAGE ? message.slice(0, MAX_MESSAGE) + '…' : message);
  if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS);
  notify?.();
}

function record(type: CapturedEvent['type'], e: Event): void {
  try {
    // The widget's own UI is excluded: its events are retargeted to the host element.
    if (e.composedPath().some((n) => n instanceof Element && n.hasAttribute('data-healops'))) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    const target = targetOf(t.closest(INTERACTIVE) ?? t);
    const last = events[events.length - 1];
    if (type === 'input' && last?.type === 'input' && last.target === target) {
      last.at = Date.now(); // coalesce keystrokes in the same field into one entry
      return;
    }
    events.push({ type, target, at: Date.now() });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  } catch {
    /* capture must never break the page */
  }
}

/** Start capturing from load. `onCapture` fires for every captured error. */
export function start(onCapture: () => void): void {
  notify = onCapture;

  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    try {
      pushError(args.map((a) => str(a)).join(' '));
    } catch {
      /* ignore */
    }
    originalError.apply(console, args);
  };

  window.addEventListener('error', (e) => {
    try {
      // benign browser noise that would otherwise pulse the pill
      if (/ResizeObserver loop/.test(e.message)) return;
      const stack = e.error && e.error.stack;
      pushError(typeof stack === 'string' && stack ? stack : `${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
    } catch {
      /* ignore */
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    try {
      pushError('Unhandled promise rejection: ' + str(e.reason));
    } catch {
      /* ignore */
    }
  });

  for (const type of EVENT_TYPES) {
    document.addEventListener(type, (e) => record(type, e), { capture: true, passive: true });
  }
}

/** Copies of the current buffers, as attached to a report. */
export function snapshot(): { events: CapturedEvent[]; consoleErrors: string[] } {
  return { events: events.slice(), consoleErrors: errors.slice() };
}
