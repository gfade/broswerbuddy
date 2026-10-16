// Live view (the demo screen): incident header, 10-stage stepper, Anchor browser panel, the stage context
// panel, and the streaming agent reasoning. Built once; update() patches only the regions that changed,
// so the live iframe is never reloaded and streamed text never re-renders the whole page.
import { api } from '../api';
import { refreshFlows, refreshStats } from '../data';
import { type Rendered, renderCalm, renderStage, type StageEnv, thinkingTail } from './stages';
import { ui, emit, isBusy, setBusy, toast } from '../state';
import { SEVERITY_INFO, SOURCE_LABEL, SPONSOR_INFO, STAGE_LABEL, STAGE_SPONSOR, STAGES, STATUS_INFO } from '../constants';
import {
  type IncidentView, type RunView, currentIncident, displayStage, lastGlobalRun, model, pickDetectRun, stageIndex,
} from '../model';
import { el, errMsg, esc, fmtAgo, fmtClock, fmtMs, hostOf, patchHtml, q, safeHref, setText } from '../util';

const SKELETON = `
<div class="live">
  <div class="calm" data-calm hidden>
    <span class="calm-ic" aria-hidden="true">✓</span>
    <b>All flows healthy — patrolling</b>
    <span class="calm-meta" data-calm-meta></span>
  </div>
  <header class="inc-head">
    <div class="inc-main">
      <div class="inc-pills"><span class="pill" data-sev></span><span class="pill" data-status></span></div>
      <h1 class="inc-title" data-title></h1>
      <div class="inc-meta" data-meta></div>
    </div>
    <div class="inc-timer"><span class="cap">Time to heal</span><span class="timer mono" data-timer>00:00</span></div>
    <div class="inc-actions">
      <button class="btn primary" type="button" data-act="run">▶ Run checkout now</button>
      <div class="menu-wrap">
        <button class="btn" type="button" data-act="break" aria-haspopup="true" aria-expanded="false">Break it again ▾</button>
        <div class="menu" data-menu hidden></div>
      </div>
      <button class="btn" type="button" data-act="takeover" data-need="active">Take over</button>
      <button class="btn danger" type="button" data-act="rollback" data-rollback>Rollback</button>
      <button class="btn" type="button" data-act="patrol" data-patrol>Pause patrol</button>
    </div>
  </header>
  <ol class="stepper" data-stepper aria-label="Pipeline stages"></ol>
  <div class="live-main">
    <section class="panel browser" aria-label="Anchor browser">
      <div class="chrome">
        <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <div class="url-bar"><span class="url" data-url></span><span class="ver mono" data-ver></span></div>
        <span class="pill" data-badge></span>
      </div>
      <div class="viewport" data-viewport></div>
      <div class="steps-strip" data-steps></div>
    </section>
    <section class="panel ctx" aria-label="Stage detail">
      <div class="ctx-head" data-ctx-head></div>
      <div class="ctx-body" data-ctx-body></div>
    </section>
  </div>
  <section class="panel reasoning" aria-label="Agent reasoning">
    <div class="reason-head">
      <span class="cap">Agent reasoning</span>
      <span class="pill" data-model></span>
      <span class="grow"></span>
      <span class="xs muted" data-live-note></span>
    </div>
    <div class="reason-stream" data-stream></div>
  </section>
</div>`;

type Viewport =
  | { kind: 'iframe'; url: string }
  | { kind: 'shot'; url: string; local: boolean }
  | { kind: 'mock'; broken: boolean; fixed: boolean; replaying: boolean; cursor: boolean; error: string; version: string }
  | { kind: 'empty'; text: string };

function chooseViewport(inc: IncidentView | undefined, run: RunView | undefined): Viewport {
  const live = safeHref(run?.liveViewUrl);
  if (live) return { kind: 'iframe', url: live };
  const shot = safeHref(run?.screenshotUrl);
  if (shot) return { kind: 'shot', url: shot, local: run?.provider === 'local' };
  if (ui.mode === 'demo' && inc) {
    const fixed = inc.deploys.some((d) => d.phase === 'promoted' && d.ok);
    const broken = !fixed && inc.runs.some((r) => r.ok === false);
    const reproduce = inc.stages.reproduce;
    const verify = inc.stages.verify;
    return {
      kind: 'mock',
      broken,
      fixed,
      replaying: reproduce.status === 'started' || verify.status === 'started',
      cursor: !fixed && stageIndex(inc) <= 1,
      error: inc.error,
      version: model.liveVersion ?? '',
    };
  }
  return {
    kind: 'empty',
    text: inc ? 'The browser frame appears once the Anchor session starts.' : 'Anchor is patrolling. The next browser session appears here.',
  };
}

function viewportHtml(vp: Viewport, storeUrl: string): string {
  switch (vp.kind) {
    case 'iframe':
      return `<iframe class="live-frame" src="${esc(vp.url)}" title="Live Anchor browser session" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe>`;
    case 'shot':
      return `<img class="shot-frame" src="${esc(vp.url)}" alt="Latest browser frame from the Anchor session" />`;
    case 'mock':
      return `<div class="mock-page" aria-hidden="true">
        <div class="mock-nav"><b>LOL Store</b><span>Shop</span><span>Deals</span><span>Account</span><span class="grow"></span><span>Cart 2</span></div>
        <div class="mock-body">
          <div class="mock-img"></div>
          <div class="mock-info">
            <div class="mock-title">Neon Hoodie</div>
            <div class="mock-sub">Discount <b>LOL20</b> applied · 2 items</div>
            <div class="mock-line" style="width:80%"></div>
            <div class="mock-line" style="width:55%"></div>
            <div class="mock-price">$49.00</div>
            <button class="mock-btn${vp.fixed ? ' fixed' : vp.broken ? ' broken' : ''}" type="button" tabindex="-1">${vp.fixed ? 'Pay now ✓' : 'Pay now'}</button>
          </div>
        </div>
        ${vp.broken && !vp.fixed ? `<div class="mock-err">✕ ${esc(vp.error)}</div>` : ''}
        ${vp.fixed ? `<div class="mock-ok">✓ ${esc(vp.version || 'new version')} deployed by HealOps · checkout passing</div>` : ''}
        ${vp.cursor ? '<div class="mock-cursor"><svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l18 9-8 2-3 8z" fill="var(--anchor)" stroke="#fff" stroke-width="1.5"/></svg><em>anchor-agent</em></div>' : ''}
        ${vp.replaying ? '<div class="mirror"><div><span class="pill" style="--c:var(--daytona)">Daytona sandbox</span><div class="h3">Replaying this session in an isolated sandbox…</div><div class="sm muted">The production site is untouched</div></div></div>' : ''}
        <span class="mock-url">${esc(storeUrl)}</span>
      </div>`;
    default:
      return `<div class="viewport-empty">${esc(vp.text)}</div>`;
  }
}

function badgeFor(vp: Viewport): { text: string; css: string } {
  switch (vp.kind) {
    case 'iframe':
      return { text: '● LIVE · Anchor', css: 'var(--anchor)' };
    case 'shot':
      return vp.local ? { text: 'LOCAL browser', css: 'var(--muted)' } : { text: '● LIVE · Anchor', css: 'var(--anchor)' };
    case 'mock':
      return { text: 'REPLAY · Anchor', css: 'var(--anchor)' };
    default:
      return { text: 'Anchor · idle', css: 'var(--muted)' };
  }
}

function pathOf(run: RunView | undefined): string {
  const goto = [...(run?.steps ?? [])].reverse().find((s) => s.name.startsWith('goto '));
  return goto ? goto.name.slice(5).trim() || '/' : '/';
}

function pickFlowId(): string {
  return ui.flows.find((f) => f.id === 'checkout')?.id ?? ui.flows.find((f) => f.critical)?.id ?? ui.flows[0]?.id ?? 'checkout';
}

export function mountLive(root: HTMLElement): { update(): void; dispose(): void } {
  root.innerHTML = SKELETON;
  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => q<T>(root, sel);
  const calm = $('[data-calm]');
  const calmMeta = $('[data-calm-meta]');
  const sevEl = $('[data-sev]');
  const statusEl = $('[data-status]');
  const titleEl = $('[data-title]');
  const metaEl = $('[data-meta]');
  const timerEl = $('[data-timer]');
  const stepper = $('[data-stepper]');
  const urlEl = $('[data-url]');
  const verEl = $('[data-ver]');
  const badgeEl = $('[data-badge]');
  const viewportEl = $('[data-viewport]');
  const stepsEl = $('[data-steps]');
  const ctxHead = $('[data-ctx-head]');
  const ctxBody = $('[data-ctx-body]');
  const streamEl = $('[data-stream]');
  const modelEl = $('[data-model]');
  const liveNote = $('[data-live-note]');
  const menu = $('[data-menu]');
  const takeover = $('[data-need]');
  const rollbackBtn = $<HTMLButtonElement>('[data-rollback]');
  const patrolBtn = $<HTMLButtonElement>('[data-patrol]');
  const breakBtn = $('[data-act="break"]');

  stepper.innerHTML = STAGES.map((s, i) => {
    const sp = SPONSOR_INFO[STAGE_SPONSOR[s]];
    return `<li><button class="st" type="button" data-stage="${i}" style="--c:${sp.css}" aria-pressed="false">
      <span class="st-n">${String(i + 1).padStart(2, '0')}</span>
      <span class="st-name">${esc(STAGE_LABEL[s])}</span>
      <span class="st-who">${esc(sp.label.toUpperCase())}</span>
      <span class="st-state" aria-hidden="true"></span>
      <i class="st-prog" aria-hidden="true"></i>
    </button></li>`;
  }).join('');
  const stepBtns = [...stepper.querySelectorAll<HTMLButtonElement>('button[data-stage]')];
  const stepStates = stepBtns.map((b) => q<HTMLElement>(b, '.st-state'));

  let followIdx = -2;
  let viewKey = '';
  let lastStageKey = '';
  let enterTimer = 0;
  let streamOwner = '';
  let streamCount = 0;
  let menuOpen = false;
  let rollbackArmedAt = 0;
  let rollbackTimer = 0;

  function calmText(inc: IncidentView | undefined): string {
    const parts: string[] = [];
    if (model.tick) {
      const left = model.tick.at + model.tick.nextInSec * 1000 - Date.now();
      parts.push(left > 0 ? `next patrol in ${fmtClock(left)}` : 'patrol due');
    } else if (ui.stats) {
      parts.push(`patrol every ${Math.round(ui.stats.patrolIntervalSec / 60)} min`);
    }
    if (inc) {
      const dur = inc.durationMs !== undefined ? ` in ${fmtMs(inc.durationMs)}` : '';
      parts.push(`last incident #${inc.id} ${STATUS_INFO[inc.status].label.toLowerCase()}${dur}`);
    }
    return parts.join(' · ');
  }

  function renderMenu(): void {
    const items = ui.seeds
      .map(
        (s) => `<button type="button" role="menuitem" data-act="seed" data-seed="${esc(s.id)}" data-flow="${esc(s.flowId)}">
          <b>${esc(s.title)}</b><span>${esc(s.description)}</span></button>`,
      )
      .join('');
    patchHtml(menu, items || '<div class="menu-empty">No seeded bugs available.</div>');
  }

  function updateStream(inc: IncidentView | undefined): void {
    const id = inc?.id ?? '';
    if (id !== streamOwner) {
      streamOwner = id;
      streamCount = 0;
      streamEl.replaceChildren();
    }
    const chunks = inc?.llm ?? [];
    if (chunks.length < streamCount) {
      streamEl.replaceChildren();
      streamCount = 0;
    }
    if (chunks.length === streamCount) return;
    const frag = document.createDocumentFragment();
    for (let i = streamCount; i < chunks.length; i++) {
      frag.append(el('span', { class: chunks[i].kind === 'thinking' ? 'thk' : 'txt' }, chunks[i].text));
    }
    streamEl.append(frag);
    streamCount = chunks.length;
    while (streamEl.childNodes.length > 900 && streamEl.firstChild) streamEl.firstChild.remove();
    const nearBottom = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 96;
    if (nearBottom) streamEl.scrollTop = streamEl.scrollHeight;
  }

  function update(): void {
    if (root.hidden) return;
    const inc = currentIncident();
    const idle = !inc || inc.closedAt !== undefined;
    const follow = inc && !idle ? (inc.currentStage ? stageIndex(inc) : 0) : -1;
    if (follow !== followIdx) {
      followIdx = follow;
      ui.stageView = undefined;
    }
    const showIdx = ui.stageView ?? follow;

    calm.hidden = !idle;
    if (idle) setText(calmMeta, calmText(inc));

    if (inc) {
      const sev = SEVERITY_INFO[inc.severity];
      setText(sevEl, sev.label);
      sevEl.style.setProperty('--c', sev.css);
      const st = STATUS_INFO[inc.status];
      setText(statusEl, `${st.icon} ${st.label}`);
      statusEl.style.setProperty('--c', st.css);
      setText(titleEl, inc.title);
      const detect = pickDetectRun(inc);
      const metaParts = [`Incident #${inc.id}`, SOURCE_LABEL[inc.source] ?? inc.source];
      if (inc.flowId) metaParts.push(`flow ${inc.flowId}`);
      if (detect?.ok === false) metaParts.push(`failed at step ${(detect.failedStep ?? 0) + 1}`);
      metaParts.push(`opened ${fmtAgo(inc.openedAt)}`);
      setText(metaEl, metaParts.join(' · '));
      setText(timerEl, fmtClock((inc.closedAt ?? Date.now()) - inc.openedAt));
    } else {
      setText(sevEl, '');
      setText(statusEl, '● ALL CLEAR');
      statusEl.style.setProperty('--c', 'var(--ok)');
      setText(titleEl, 'No incidents yet');
      setText(metaEl, ui.stats ? `Patrolling ${ui.flows.length} flows · ${ui.stats.incidents} incidents on record` : 'Connecting to the patrol…');
      setText(timerEl, '00:00');
    }
    takeover.hidden = idle;

    // stepper
    stepBtns.forEach((btn, i) => {
      const status = inc ? displayStage(inc, i) : 'pending';
      const cls = `st st-${status}${showIdx === i ? ' viewing' : ''}${follow === i && !idle ? ' current' : ''}`;
      if (btn.className !== cls) btn.className = cls;
      const mark = status === 'completed' ? '✓' : status === 'failed' ? '✕' : status === 'skipped' ? '–' : status === 'started' ? '●' : '';
      setText(stepStates[i], mark);
      btn.setAttribute('aria-pressed', String(showIdx === i));
    });

    // browser
    const run = inc ? pickDetectRun(inc) ?? inc.runs[inc.runs.length - 1] : lastGlobalRun();
    const vp = chooseViewport(inc, run);
    const storeUrl = `${hostOf(ui.liveUrl || '')}${pathOf(run)}`;
    setText(urlEl, storeUrl);
    setText(verEl, model.liveVersion ?? ui.stats?.liveVersion ?? '');
    const badge = badgeFor(vp);
    setText(badgeEl, badge.text);
    badgeEl.style.setProperty('--c', badge.css);
    const key = JSON.stringify(vp);
    if (key !== viewKey) {
      viewKey = key;
      patchHtml(viewportEl, viewportHtml(vp, ui.liveUrl || ''));
    }
    const steps = run?.steps ?? [];
    patchHtml(
      stepsEl,
      steps.length
        ? steps
            .map((s) => `<span class="step ${s.ok ? 'ok' : 'bad'}"><b>${String(s.index + 1).padStart(2, '0')}</b>${esc(s.name)}<i>${fmtMs(s.durationMs)}</i></span>`)
            .join('')
        : '<span class="muted sm">Anchor steps appear here as the flow runs.</span>',
    );

    // stage context panel
    const env: StageEnv = { demo: ui.mode === 'demo', busy: isBusy, now: Date.now() };
    let rendered: Rendered;
    if (inc && showIdx >= 0) {
      rendered = renderStage(showIdx, inc, env);
    } else {
      const nextAt = model.tick ? model.tick.at + model.tick.nextInSec * 1000 : undefined;
      rendered = renderCalm(ui.flows, nextAt, inc, env);
    }
    patchHtml(ctxHead, rendered.head);
    patchHtml(ctxBody, rendered.body);
    const stageKey = `${inc?.id ?? ''}:${inc && showIdx >= 0 ? showIdx : 'calm'}`;
    if (stageKey !== lastStageKey) {
      lastStageKey = stageKey;
      ctxBody.classList.add('enter');
      window.clearTimeout(enterTimer);
      enterTimer = window.setTimeout(() => ctxBody.classList.remove('enter'), 1400);
    }
    const thinking = ctxBody.querySelector<HTMLElement>('[data-thinking]');
    if (thinking && inc) setText(thinking, thinkingTail(inc));

    // reasoning stream
    updateStream(inc);
    const aw = SPONSOR_INFO.bedrock.css;
    setText(modelEl, inc?.llmModel ? `Bedrock · ${inc.llmModel}` : 'Bedrock · idle');
    modelEl.style.setProperty('--c', aw);
    setText(liveNote, inc && !idle ? 'streaming' : 'idle');

    // header controls
    const busyRollback = isBusy('rollback');
    rollbackBtn.disabled = busyRollback;
    const armed = Date.now() - rollbackArmedAt < 4000;
    setText(rollbackBtn, armed ? 'Confirm rollback?' : 'Rollback');
    rollbackBtn.classList.toggle('armed', armed);
    const patrolling = ui.stats?.patrolling ?? true;
    setText(patrolBtn, patrolling ? 'Pause patrol' : 'Start patrol');
    patrolBtn.disabled = isBusy('patrol');
    breakBtn.setAttribute('aria-expanded', String(menuOpen));
    menu.hidden = !menuOpen;
    if (menuOpen) renderMenu();
  }

  // --- actions ---------------------------------------------------------------

  async function guarded(key: string, action: () => Promise<void>): Promise<void> {
    if (isBusy(key)) return;
    setBusy(key, true);
    try {
      await action();
    } catch (err) {
      toast('bad', errMsg(err));
    } finally {
      setBusy(key, false);
    }
  }

  async function runFlow(flowId: string): Promise<void> {
    const out = await api.runFlow(flowId);
    const r = out.result;
    if (r.ok) toast('ok', `${flowId} passed in ${fmtMs(r.durationMs)}`);
    else toast('bad', `${flowId} failed${out.incidentId ? ` · incident #${out.incidentId} opened` : ''}`);
    void refreshFlows();
  }

  function onClick(ev: Event): void {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    if (menuOpen && !target.closest('.menu-wrap')) {
      menuOpen = false;
      menu.hidden = true;
      breakBtn.setAttribute('aria-expanded', 'false');
    }
    const stageBtn = target.closest<HTMLElement>('[data-stage]');
    if (stageBtn) {
      const i = Number(stageBtn.dataset.stage);
      const inc = currentIncident();
      const following = ui.stageView === undefined && (inc && inc.closedAt === undefined ? stageIndex(inc) : -1) === i;
      ui.stageView = following ? undefined : i;
      emit();
      return;
    }
    const actEl = target.closest<HTMLElement>('[data-act]');
    if (!actEl || actEl.hasAttribute('disabled')) return;
    const act = actEl.dataset.act;
    const inc = currentIncident();

    if (act === 'run') {
      void guarded('run', () => runFlow(pickFlowId()));
    } else if (act === 'break') {
      menuOpen = !menuOpen;
      menu.hidden = !menuOpen;
      breakBtn.setAttribute('aria-expanded', String(menuOpen));
      if (menuOpen) renderMenu();
    } else if (act === 'seed') {
      const seedId = actEl.dataset.seed ?? '';
      const flowId = actEl.dataset.flow ?? pickFlowId();
      menuOpen = false;
      menu.hidden = true;
      const seed = ui.seeds.find((s) => s.id === seedId);
      void guarded('seed', async () => {
        await api.reseed(seedId);
        toast('warn', `Bug re-injected: ${seed?.title ?? seedId}`);
        await runFlow(flowId);
      });
    } else if (act === 'takeover' && inc) {
      void guarded('takeover', async () => {
        await api.takeover(inc.id);
        toast('info', 'Agent paused. The incident is yours to handle.');
      });
    } else if (act === 'rollback') {
      if (Date.now() - rollbackArmedAt >= 4000) {
        rollbackArmedAt = Date.now();
        window.clearTimeout(rollbackTimer);
        rollbackTimer = window.setTimeout(() => emit(), 4100);
        emit();
        return;
      }
      rollbackArmedAt = 0;
      void guarded('rollback', async () => {
        const out = await api.rollback();
        toast('warn', `Rolled back to ${out.restoredVersion}`);
      });
    } else if (act === 'patrol') {
      const on = !(ui.stats?.patrolling ?? true);
      void guarded('patrol', async () => {
        await api.patrol(on);
        toast('info', on ? 'Patrol resumed' : 'Patrol paused');
        await refreshStats();
      });
    } else if (act === 'approve') {
      const id = actEl.dataset.id ?? '';
      const approved = actEl.dataset.approved === 'true';
      void guarded(`approve:${id}`, async () => {
        await api.approve(id, approved);
        toast(approved ? 'ok' : 'warn', approved ? 'Approved. Deploying the canary.' : 'Rejected. The patch will not ship.');
      });
    }
    emit();
  }

  root.addEventListener('click', onClick);
  const timerId = window.setInterval(() => {
    if (root.hidden) return;
    const inc = currentIncident();
    setText(timerEl, inc ? fmtClock((inc.closedAt ?? Date.now()) - inc.openedAt) : '00:00');
    if (!calm.hidden) setText(calmMeta, calmText(inc));
  }, 250);

  return {
    update,
    dispose() {
      window.clearInterval(timerId);
      root.removeEventListener('click', onClick);
    },
  };
}
