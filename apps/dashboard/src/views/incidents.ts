// Incidents view: filterable history table, and a drawer for one incident (fetched from
// GET /api/incidents/:id) with the event timeline, span waterfall, patch diff and eval rubric.
import type { IncidentDetail, IncidentEvent, IncidentSummary, RecordedSpan, Sponsor } from '@healops/shared/types';
import { api } from '../api';
import { diffHtml, mountWaterfall, rubricHtml, scoreRingHtml, type WaterRow } from '../charts';
import { SOURCE_LABEL, SPONSOR_INFO, STAGE_LABEL, STAGE_SPONSOR, STATUS_INFO } from '../constants';
import { emit, type StatusTab, toast, ui } from '../state';
import { errMsg, esc, fmtClock, fmtMs, fmtSec, patchHtml, q, safeHref, setText } from '../util';

const TABS: { id: StatusTab; label: string; statuses?: string[] }[] = [
  { id: 'all', label: 'All' },
  { id: 'healing', label: 'Healing', statuses: ['open', 'healing'] },
  { id: 'review', label: 'Needs review', statuses: ['awaiting_approval', 'escalated'] },
  { id: 'resolved', label: 'Resolved', statuses: ['healed'] },
  { id: 'rolled', label: 'Rolled back', statuses: ['rolled_back'] },
  { id: 'other', label: 'Other', statuses: ['quarantined', 'rejected', 'failed', 'not_reproducible'] },
];

const SKELETON = `
<div class="view-inner incidents">
  <div class="view-head">
    <div><h2>Incidents</h2><p class="muted sm">Every incident the agent has handled, newest first</p></div>
    <span class="grow"></span>
    <input class="search" type="search" placeholder="Filter by title, flow or id" aria-label="Filter incidents" data-q />
    <button class="btn" type="button" data-export>Export CSV</button>
  </div>
  <div class="tabs2" role="tablist" aria-label="Status filter" data-tabs></div>
  <div class="split" data-split>
    <div class="panel table-wrap">
      <table class="ut">
        <thead><tr><th>Incident</th><th>Status</th><th>Source</th><th>Flow</th><th class="num">Heal time</th><th class="num">Score</th><th>Memory</th></tr></thead>
        <tbody data-rows></tbody>
      </table>
      <div class="empty" data-empty hidden>No incidents match this filter.</div>
    </div>
    <aside class="panel drawer" data-drawer hidden aria-label="Incident detail"></aside>
  </div>
</div>`;

function spanSponsor(s: RecordedSpan): Sponsor | undefined {
  const sp = s.attributes['healops.sponsor'];
  if (typeof sp === 'string' && sp in SPONSOR_INFO) return sp as Sponsor;
  const stage = s.attributes['healops.stage'];
  if (typeof stage === 'string' && stage in STAGE_SPONSOR) return STAGE_SPONSOR[stage as keyof typeof STAGE_SPONSOR];
  return undefined;
}

function describe(e: IncidentEvent): { sponsor?: Sponsor; text: string } | undefined {
  switch (e.type) {
    case 'incident.opened':
      return { text: `Opened: ${e.title}` };
    case 'stage.changed':
      return { sponsor: e.sponsor, text: `${STAGE_LABEL[e.stage]} ${e.status}${e.detail ? ` · ${e.detail}` : ''}` };
    case 'flow.started':
      return { sponsor: 'anchor', text: `Flow ${e.flowId} started (${e.purpose})` };
    case 'flow.completed':
      return { sponsor: 'anchor', text: `Flow ${e.flowId} ${e.ok ? 'passed' : 'failed'} in ${fmtMs(e.durationMs)}` };
    case 'triage.result':
      return { sponsor: 'bedrock', text: `Triage: guard ${e.safe ? 'clean' : 'blocked'} · ${e.severity}` };
    case 'memory.match':
      return {
        sponsor: 'surreal',
        text: e.matches.length ? `Recall: ${e.matches.length} similar bug(s), best ${e.matches[0].similarity.toFixed(2)}` : 'Recall: no similar bug',
      };
    case 'sandbox.created':
      return { sponsor: 'daytona', text: `Sandbox ${e.sandboxId} created` };
    case 'sandbox.result':
      return { sponsor: 'daytona', text: `${e.phase}: ${e.passed ? 'passed' : 'failed'} · ${e.summary}` };
    case 'patch.ready':
      return { sponsor: 'bedrock', text: `Patch ready (attempt ${e.attempt}, confidence ${e.confidence.toFixed(2)})` };
    case 'patch.rejected':
      return { sponsor: 'bedrock', text: `Patch rejected (attempt ${e.attempt}): ${e.reason}` };
    case 'gate.decision':
      return { sponsor: 'arize', text: `Gate: ${e.decision.replace('_', ' ')} · risk ${e.risk}` };
    case 'approval.resolved':
      return { text: `Approval ${e.approved ? 'granted' : 'refused'}` };
    case 'deploy.progress':
      return { sponsor: 'aws', text: `Deploy ${e.phase} ${e.version}${e.ok ? '' : ' (failed)'}` };
    case 'eval.scored':
      return { sponsor: 'arize', text: `Judged ${Math.round(e.score)} of 100 · ${e.verdict}` };
    case 'memory.learned':
      return { sponsor: 'surreal', text: `Learned bug ${e.bugId} → fix ${e.fixId}` };
    case 'incident.closed':
      return { text: `Closed: ${e.outcome.replace('_', ' ')} in ${fmtMs(e.durationMs)}` };
    case 'log':
      return { sponsor: e.sponsor, text: e.message };
    default:
      return undefined;
  }
}

function isActive(s: IncidentSummary): boolean {
  return s.status === 'open' || s.status === 'healing' || s.status === 'awaiting_approval';
}

function statusPill(s: IncidentSummary): string {
  const st = STATUS_INFO[s.status];
  return `<span class="pill" style="--c:${st.css}">${esc(st.icon)} ${esc(st.label)}</span>`;
}

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(rows: IncidentSummary[]): void {
  const head = ['id', 'title', 'status', 'source', 'flow', 'severity', 'opened_at', 'closed_at', 'heal_ms', 'score', 'memory_hit'];
  const lines = rows.map((s) =>
    [s.id, s.title, s.status, s.source, s.flowId, s.severity, new Date(s.openedAt).toISOString(), s.closedAt ? new Date(s.closedAt).toISOString() : '', s.healMs, s.score, s.memoryHit]
      .map(csvCell)
      .join(','),
  );
  const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'healops-incidents.csv';
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountIncidents(root: HTMLElement): { update(): void; dispose(): void } {
  root.innerHTML = SKELETON;
  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => q<T>(root, sel);
  const tabsEl = $('[data-tabs]');
  const rowsEl = $('[data-rows]');
  const emptyEl = $('[data-empty]');
  const drawerEl = $('[data-drawer]');
  const searchEl = $<HTMLInputElement>('[data-q]');
  const splitEl = $('[data-split]');

  const details = new Map<string, IncidentDetail>();
  const loading = new Set<string>();
  const loadedAt = new Map<string, number>();
  const failures = new Map<string, string>();
  let drawerKey = '';
  let waterfallHost: HTMLElement | undefined;

  async function loadDetail(id: string): Promise<void> {
    if (loading.has(id)) return;
    loading.add(id);
    loadedAt.set(id, Date.now());
    try {
      details.set(id, await api.incident(id));
      failures.delete(id);
    } catch (err) {
      failures.set(id, errMsg(err));
    } finally {
      loading.delete(id);
      emit();
    }
  }

  function filtered(): IncidentSummary[] {
    const tab = TABS.find((t) => t.id === ui.statusTab);
    const q = ui.query.trim().toLowerCase();
    return ui.incidents.filter((s) => {
      if (tab?.statuses && !tab.statuses.includes(s.status)) return false;
      if (!q) return true;
      return [s.title, s.flowId ?? '', s.id].some((v) => v.toLowerCase().includes(q));
    });
  }

  function renderTabs(): void {
    const counts = (statuses?: string[]): number =>
      statuses ? ui.incidents.filter((s) => statuses.includes(s.status)).length : ui.incidents.length;
    const html = TABS.map(
      (t) =>
        `<button type="button" role="tab" class="tab2" data-tab="${t.id}" aria-selected="${ui.statusTab === t.id}">${esc(t.label)} <span class="count mono">${counts(t.statuses)}</span></button>`,
    ).join('');
    patchHtml(tabsEl, html);
  }

  function drawerHtml(id: string, s: IncidentSummary | undefined, d: IncidentDetail | undefined, failure: string | undefined): string {
    const summary = d ?? s;
    if (!summary) return `<div class="drawer-empty">${failure ? esc(failure) : 'Loading incident…'}</div>`;
    const st = STATUS_INFO[summary.status];
    const t0 = d?.events[0]?.at ?? summary.openedAt;
    const timeline = (d?.events ?? [])
      .map((e) => {
        const info = describe(e);
        if (!info) return '';
        const sp = info.sponsor ? SPONSOR_INFO[info.sponsor] : undefined;
        return `<li class="tl-row"><span class="tl-t mono">${fmtClock(e.at - t0)}</span><span class="tl-dot" style="--c:${sp?.css ?? 'var(--muted)'}" aria-hidden="true"></span><div class="tl-body">${sp ? `<span class="pill" style="--c:${sp.css}">${esc(sp.label)}</span>` : ''}<span class="tl-text">${esc(info.text)}</span></div></li>`;
      })
      .join('');
    const spans = d?.spans ?? [];
    const spanRows = spans
      .map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.status)}</td><td class="num">${fmtMs(s.endMs !== undefined ? s.endMs - s.startMs : undefined)}</td></tr>`)
      .join('');
    const patch = d?.patch
      ? `<div class="sec-h">Patch · ${esc(d.patch.model)}</div><p class="sm"><b>${esc(d.patch.summary)}</b></p><p class="sm muted">${esc(d.patch.rootCause)}</p>${diffHtml(d.patch.diff)}`
      : '';
    const evalPart = d?.eval
      ? `<div class="sec-h">Judge</div><div class="judge-top">${scoreRingHtml(d.eval.score, 96)}<div class="col"><b class="verdict">${esc(d.eval.verdict)}</b><span class="sm muted">${esc(d.eval.model)}</span></div></div><div class="rubric">${rubricHtml(d.eval.rubric)}</div>`
      : '';
    const shot = safeHref(d?.screenshotUrl);
    return `<div class="drawer-head">
        <span class="pill" style="--c:${st.css}">${esc(st.icon)} ${esc(st.label)}</span>
        <span class="mono muted sm">#${esc(id)}</span><span class="grow"></span>
        <button class="btn ghost sm" type="button" data-close aria-label="Close">✕</button>
      </div>
      <h3 class="drawer-title">${esc(summary.title)}</h3>
      <p class="sm muted">${summary.healMs !== undefined ? `Healed in ${fmtSec(summary.healMs)}` : summary.closedAt ? 'Closed' : 'In progress'}${summary.score !== undefined ? ` · score ${Math.round(summary.score)}` : ''}${summary.error ? ` · ${esc(summary.error)}` : ''}</p>
      ${failure ? `<p class="sm bad">${esc(failure)}</p>` : ''}
      ${shot ? `<img class="shot-frame small" src="${esc(shot)}" alt="Screenshot at the point of failure" />` : ''}
      <div class="sec-h">Timeline</div>
      <ol class="timeline">${timeline || '<li class="muted sm">No events recorded.</li>'}</ol>
      <div class="sec-h">Spans</div>
      ${spans.length ? '<div data-waterfall class="wf-host"></div>' : '<p class="sm muted">No spans recorded.</p>'}
      ${spans.length ? `<details class="table-twin"><summary>Show spans as a table</summary><table class="ut sm"><thead><tr><th>Span</th><th>Status</th><th class="num">Duration</th></tr></thead><tbody>${spanRows}</tbody></table></details>` : ''}
      ${patch}${evalPart}`;
  }

  function renderDrawer(): void {
    if (!ui.drawerId) {
      drawerEl.hidden = true;
      splitEl.classList.remove('open');
      waterfallHost = undefined;
      drawerKey = '';
      return;
    }
    const id = ui.drawerId;
    drawerEl.hidden = false;
    splitEl.classList.add('open');
    const summary = ui.incidents.find((s) => s.id === id);
    const d = details.get(id);
    const key = `${id}:${JSON.stringify(d?.events.length ?? 0)}:${d ? 'd' : 'n'}:${failures.get(id) ?? ''}:${summary?.status ?? ''}`;
    if (key === drawerKey) return;
    drawerKey = key;
    patchHtml(drawerEl, drawerHtml(id, summary, d, failures.get(id)));
    waterfallHost = drawerEl.querySelector<HTMLElement>('[data-waterfall]') ?? undefined;
    if (waterfallHost && d) {
      const spans = [...d.spans].sort((a, b) => a.startMs - b.startMs);
      const rows: WaterRow[] = spans.map((s) => ({
        name: s.name,
        sponsor: spanSponsor(s),
        startMs: s.startMs,
        endMs: s.endMs ?? s.startMs,
        status: s.status,
      }));
      mountWaterfall(waterfallHost, rows);
    }
  }

  function update(): void {
    if (root.hidden) return;
    renderTabs();
    const rows = filtered();
    const selected = ui.drawerId;
    patchHtml(
      rowsEl,
      rows
        .map((s) => {
          const memory = s.memoryHit ? `#${esc(s.memoryHit)} ✓` : 'none';
          return `<tr class="${s.id === selected ? 'sel' : ''}" data-id="${esc(s.id)}" tabindex="0" aria-selected="${s.id === selected}">
          <td><div class="inc-cell"><span class="mono muted sm">#${esc(s.id)}</span><b>${esc(s.title)}</b></div></td>
          <td>${statusPill(s)}</td>
          <td class="sm">${esc(SOURCE_LABEL[s.source] ?? s.source)}</td>
          <td class="mono sm">${esc(s.flowId ?? '—')}</td>
          <td class="num">${s.healMs !== undefined ? fmtSec(s.healMs) : '—'}</td>
          <td class="num">${s.score !== undefined ? Math.round(s.score) : '—'}</td>
          <td class="sm mono">${memory}</td></tr>`;
        })
        .join(''),
    );
    emptyEl.hidden = rows.length > 0;
    if (ui.incidents.length === 0) setText(emptyEl, 'No incidents recorded yet.');
    if (selected) {
      const s = ui.incidents.find((x) => x.id === selected);
      const last = loadedAt.get(selected) ?? 0;
      const stale = Date.now() - last > 4000 && (s ? isActive(s) : true);
      if (stale && !loading.has(selected)) void loadDetail(selected);
    }
    renderDrawer();
  }

  function open(id: string): void {
    ui.drawerId = id;
    void loadDetail(id);
    emit();
  }

  root.addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    const tab = target.closest<HTMLElement>('[data-tab]');
    if (tab) {
      ui.statusTab = tab.dataset.tab as StatusTab;
      emit();
      return;
    }
    if (target.closest('[data-export]')) {
      exportCsv(filtered());
      toast('ok', `Exported ${filtered().length} incidents`);
      return;
    }
    if (target.closest('[data-close]')) {
      ui.drawerId = undefined;
      emit();
      return;
    }
    const row = target.closest<HTMLElement>('tr[data-id]');
    if (row?.dataset.id) open(row.dataset.id);
  });
  root.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const target = ev.target instanceof Element ? ev.target : null;
    const row = target?.closest<HTMLElement>('tr[data-id]');
    if (row?.dataset.id) open(row.dataset.id);
  });
  root.addEventListener('input', (ev) => {
    if (ev.target === searchEl) {
      ui.query = searchEl.value;
      emit();
    }
  });

  return { update, dispose() {} };
}
