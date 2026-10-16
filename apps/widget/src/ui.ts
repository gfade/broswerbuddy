import { pollIncident, postFlag } from './api';
import { snapshot } from './capture';
import { finalDetail, isTerminal, progressText, versionOf } from './status';
import { CSS } from './styles';
import type { FlagRequest } from './types';

const MAX_NOTE = 2000;
const TOAST_MS = 20000;

const MARKUP = `<style>${CSS}</style>
<button class="pill" id="pill" type="button" aria-expanded="false" aria-controls="sheet">🐞 Bugs?</button>
<section class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="title" hidden>
  <header><h2 id="title">What went wrong?</h2><button class="icon" id="x" type="button" aria-label="Close">✕</button></header>
  <div id="form">
    <textarea id="note" maxlength="${MAX_NOTE}" aria-label="Describe what happened" placeholder="e.g. The pay button does nothing after I apply a coupon"></textarea>
    <div class="count" id="count">0/${MAX_NOTE}</div>
    <ul class="checks">
      <li id="c-replay"></li>
      <li id="c-errors"></li>
      <li id="c-device"></li>
    </ul>
    <p class="err" id="err" role="alert"></p>
    <div class="actions">
      <button id="cancel" type="button">Cancel</button>
      <button class="primary" id="send" type="button">Send</button>
    </div>
  </div>
  <div id="done" hidden>
    <p class="status" id="status" aria-live="polite"></p>
    <div class="actions"><button class="primary" id="close" type="button">Close</button></div>
  </div>
</section>
<div class="toast" id="toast" hidden><span id="toast-text" role="status"></span><button class="icon" id="toast-x" type="button" aria-label="Dismiss">✕</button></div>`;

export interface Widget {
  open(): void;
  close(): void;
  /** One-time pulse on the pill, called when an error is first captured. */
  pulse(): void;
}

/** Builds the pill, the report sheet and the toast in a closed shadow root, then attaches them to the page. */
export function createWidget(endpoint: string): Widget {
  const host = document.createElement('div');
  host.setAttribute('data-healops', '');
  host.style.cssText = 'all:initial;display:block';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = MARKUP;

  const $ = <T extends HTMLElement>(id: string): T => root.getElementById(id) as T;
  const pill = $<HTMLButtonElement>('pill');
  const sheet = $<HTMLElement>('sheet');
  const titleEl = $<HTMLElement>('title');
  const formView = $<HTMLElement>('form');
  const doneView = $<HTMLElement>('done');
  const statusEl = $<HTMLElement>('status');
  const note = $<HTMLTextAreaElement>('note');
  const countEl = $<HTMLElement>('count');
  const errEl = $<HTMLElement>('err');
  const sendBtn = $<HTMLButtonElement>('send');
  const closeBtn = $<HTMLButtonElement>('close');
  const cReplay = $<HTMLElement>('c-replay');
  const cErrors = $<HTMLElement>('c-errors');
  const cDevice = $<HTMLElement>('c-device');
  const toastEl = $<HTMLElement>('toast');
  const toastText = $<HTMLElement>('toast-text');

  let isOpen = false;
  let pulsed = false;
  let doneHeadline = '';
  let doneDetail = '';
  /** Set while an incident is being polled; cancels the poll. */
  let stopTracking: (() => void) | undefined;
  let toastTimer: number | undefined;

  function refreshChecklist(): void {
    const { events, consoleErrors } = snapshot();
    const n = events.length;
    cReplay.textContent = `${n ? '✓' : '–'} Session replay (${n} ${n === 1 ? 'event' : 'events'})`;
    cErrors.textContent = consoleErrors.length ? `✓ Console errors (${consoleErrors.length})` : '– No console errors';
    cDevice.textContent = `✓ Device ${innerWidth}×${innerHeight}`;
  }

  function updateCount(): void {
    countEl.textContent = `${note.value.length}/${MAX_NOTE}`;
  }

  function setErr(message: string): void {
    errEl.textContent = message;
  }

  function showForm(): void {
    titleEl.textContent = 'What went wrong?';
    formView.hidden = false;
    doneView.hidden = true;
  }

  function paintDone(): void {
    titleEl.textContent = doneHeadline;
    statusEl.textContent = doneDetail;
  }

  /** Updates the done view's text; touches the DOM only while the done view is showing. */
  function setDone(headline: string, detail: string): void {
    doneHeadline = headline;
    doneDetail = detail;
    if (!doneView.hidden) paintDone();
  }

  function setDetail(detail: string): void {
    doneDetail = detail;
    if (!doneView.hidden) statusEl.textContent = detail;
  }

  function showDone(headline: string, detail: string): void {
    doneHeadline = headline;
    doneDetail = detail;
    formView.hidden = true;
    doneView.hidden = false;
    paintDone();
    if (isOpen) closeBtn.focus();
  }

  function openSheet(): void {
    if (isOpen) return;
    isOpen = true;
    sheet.hidden = false;
    pill.setAttribute('aria-expanded', 'true');
    refreshChecklist();
    if (stopTracking) {
      // a report is still being worked on: show its progress instead of an empty form
      formView.hidden = true;
      doneView.hidden = false;
      paintDone();
      closeBtn.focus();
    } else {
      showForm();
      note.focus();
    }
  }

  function close(restoreFocus = sheet.contains(root.activeElement)): void {
    if (!isOpen) return;
    isOpen = false;
    sheet.hidden = true;
    pill.setAttribute('aria-expanded', 'false');
    if (restoreFocus) pill.focus();
  }

  /** Keeps Tab / Shift+Tab inside the open sheet. */
  function trapFocus(e: KeyboardEvent): void {
    const items = Array.from(sheet.querySelectorAll<HTMLElement>('button, textarea')).filter(
      (el) => !el.closest('[hidden]') && !(el as HTMLButtonElement).disabled,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = root.activeElement;
    const inside = sheet.contains(active);
    if (e.shiftKey && (!inside || active === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || active === last)) {
      e.preventDefault();
      first.focus();
    }
  }

  function toast(text: string): void {
    toastText.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(hideToast, TOAST_MS);
  }

  function hideToast(): void {
    clearTimeout(toastTimer);
    toastEl.hidden = true;
  }

  function track(incidentId: string): void {
    stopTracking?.();
    stopTracking = pollIncident(
      endpoint,
      incidentId,
      (inc) => {
        if (inc.status === 'healed') {
          stopTracking = undefined;
          if (isOpen && !doneView.hidden) close();
          const version = versionOf(inc);
          toast(version ? `Fixed in v${version} 🎉 — thanks for reporting!` : 'Fixed 🎉 — thanks for reporting!');
          return true;
        }
        if (isTerminal(inc.status)) {
          stopTracking = undefined;
          setDone('Thanks!', finalDetail(inc.status));
          return true;
        }
        setDetail(progressText(inc));
        return false;
      },
      () => {
        stopTracking = undefined;
        setDone('Thanks!', 'Still on it. We will keep you posted.');
      },
    );
  }

  async function send(): Promise<void> {
    const text = note.value.trim();
    if (!text) {
      setErr('Please describe what went wrong.');
      note.focus();
      return;
    }
    setErr('');
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    const { events, consoleErrors } = snapshot();
    const body: FlagRequest = {
      note: text,
      url: location.href,
      events,
      consoleErrors,
      viewport: [innerWidth, innerHeight],
      userAgent: navigator.userAgent,
    };
    try {
      const res = await postFlag(endpoint, body);
      note.value = '';
      updateCount();
      if (res.quarantined) {
        showDone('Thanks — our team will review this report.', '');
      } else if (res.incidentId) {
        showDone('Thanks! HealOps is on it 🤖', 'Looking into it…');
        track(res.incidentId);
      } else {
        showDone('Thanks! We got your report.', '');
      }
    } catch {
      setErr("Couldn't reach HealOps. Check your connection and try again.");
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }
  }

  function pulse(): void {
    if (pulsed) return;
    pulsed = true;
    pill.classList.add('pulse');
  }

  pill.addEventListener('click', () => (isOpen ? close() : openSheet()));
  pill.addEventListener('animationend', () => pill.classList.remove('pulse'));
  $<HTMLButtonElement>('x').addEventListener('click', () => close());
  $<HTMLButtonElement>('cancel').addEventListener('click', () => close());
  closeBtn.addEventListener('click', () => close());
  sendBtn.addEventListener('click', () => void send());
  $<HTMLButtonElement>('toast-x').addEventListener('click', hideToast);
  note.addEventListener('input', () => {
    updateCount();
    setErr('');
  });
  note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  });
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') trapFocus(e);
  });
  document.addEventListener('keydown', (e) => {
    if (isOpen && e.key === 'Escape') close();
  });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (isOpen && !e.composedPath().includes(host)) close(false);
    },
    true,
  );

  if (document.body) document.body.appendChild(host);
  else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(host), { once: true });

  return { open: openSheet, close: () => close(), pulse };
}
