// Flows view: every patrolled flow with its last run, pass/fail history and a "run now" button.
import { api } from '../api';
import { refreshFlows } from '../data';
import { stripHtml } from '../charts';
import { isBusy, setBusy, toast, ui } from '../state';
import { errMsg, esc, fmtAgo, fmtMs, patchHtml, q } from '../util';

const SKELETON = `
<div class="view-inner flows">
  <div class="view-head">
    <div><h2>Flows</h2><p class="muted sm">User journeys the Anchor browser patrols on the live store</p></div>
    <span class="grow"></span>
    <a class="btn" data-store target="_blank" rel="noopener noreferrer">Open store ↗</a>
  </div>
  <div class="flow-cards" data-cards></div>
</div>`;

export function mountFlows(root: HTMLElement): { update(): void; dispose(): void } {
  root.innerHTML = SKELETON;
  const cards = q<HTMLElement>(root, '[data-cards]');
  const store = q<HTMLAnchorElement>(root, '[data-store]');

  function update(): void {
    if (root.hidden) return;
    if (ui.liveUrl) store.href = ui.liveUrl;
    patchHtml(
      cards,
      ui.flows
        .map((f) => {
          const lr = f.lastRun;
          const status = lr
            ? `<span class="pill" style="--c:${lr.ok ? 'var(--ok)' : 'var(--bad)'}">${lr.ok ? '✓ PASSING' : '✕ FAILING'}</span>`
            : '<span class="pill" style="--c:var(--muted)">NOT RUN</span>';
          const busy = isBusy(`flow:${f.id}`);
          return `<section class="panel pad flow-card">
            <div class="row-gap"><b class="h3">${esc(f.name)}</b>${f.critical ? '<span class="tag">critical</span>' : ''}<span class="grow"></span>${status}</div>
            <p class="sm muted">${esc(f.description)}</p>
            ${stripHtml(f.history)}
            <div class="row-gap"><span class="xs muted mono">${lr ? `${fmtAgo(lr.at)} · ${fmtMs(lr.durationMs)} · ${esc(lr.provider)}` : `id ${esc(f.id)}`}</span><span class="grow"></span>
            <button class="btn primary sm" type="button" data-run="${esc(f.id)}"${busy ? ' disabled' : ''}>${busy ? 'Running…' : '▶ Run now'}</button></div>
          </section>`;
        })
        .join('') || '<div class="empty">No flows yet.</div>',
    );
  }

  const onClick = (ev: Event): void => {
    const t = ev.target instanceof Element ? ev.target.closest<HTMLElement>('[data-run]') : null;
    const id = t?.dataset.run;
    if (!id || isBusy(`flow:${id}`)) return;
    setBusy(`flow:${id}`, true);
    api
      .runFlow(id)
      .then((out) => {
        if (out.result.ok) toast('ok', `${id} passed in ${fmtMs(out.result.durationMs)}`);
        else toast('bad', `${id} failed${out.incidentId ? ` · incident #${out.incidentId} opened` : ''}`);
      })
      .catch((err) => toast('bad', errMsg(err)))
      .finally(() => {
        setBusy(`flow:${id}`, false);
        void refreshFlows();
      });
  };
  root.addEventListener('click', onClick);
  return { update, dispose: () => root.removeEventListener('click', onClick) };
}
