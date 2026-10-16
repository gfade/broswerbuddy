// Context panel content for each pipeline stage (the right-hand panel of the Live view), plus the calm
// patrol state shown when nothing is healing. Everything here is an HTML string built from escaped data.
import type { FlowInfo } from '@healops/shared/types';
import { meterHtml, rubricHtml, scoreRingHtml, stripHtml, diffHtml } from '../charts';
import { SEVERITY_INFO, SPONSOR_INFO, STAGES, STAGE_LABEL, STAGE_SPONSOR, STAGE_TITLE, STATUS_INFO } from '../constants';
import { type IncidentView, pickDetectRun } from '../model';
import { esc, fmtMs, fmtClock, safeHref, short } from '../util';

export interface StageEnv {
  demo: boolean;
  busy(key: string): boolean;
  now: number;
}

export interface Rendered {
  head: string;
  body: string;
}

const PHASE_LABEL: Record<string, string> = {
  canary: 'Canary live on a small share of traffic',
  smoke: 'Anchor smoke test on the canary',
  promoted: 'Promoted to all traffic',
  rolled_back: 'Rolled back to the previous version',
  failed: 'Deploy failed',
};

function pill(text: string, css: string, icon?: string, solid = false): string {
  return `<span class="pill${solid ? ' solid' : ''}" style="--c:${css}">${icon ? `<span class="ic">${icon}</span>` : ''}${esc(text)}</span>`;
}

function waiting(text: string): string {
  return `<div class="waiting"><span class="blink" aria-hidden="true">●</span> ${esc(text)}</div>`;
}

function head(stageIndex: number, meta: string): string {
  const s = STAGES[stageIndex];
  const sp = SPONSOR_INFO[STAGE_SPONSOR[s]];
  return `${pill(sp.label, sp.css, '●')}<b class="ctx-title">${esc(STAGE_TITLE[s])}</b><span class="grow"></span><span class="ctx-meta mono">${esc(meta)}</span>`;
}

function termClass(line: string): string {
  if (/✘|✕|error|fail/i.test(line)) return 'err';
  if (/✓|passed|green/i.test(line)) return 'ok';
  if (line.trim().startsWith('$')) return 'cmd';
  return '';
}

function detectBody(inc: IncidentView): string {
  const run = pickDetectRun(inc);
  const steps = run?.steps ?? [];
  const failIdx = run?.failedStep ?? steps.findIndex((s) => !s.ok);
  const rows = steps.length
    ? steps
        .map(
          (s) =>
            `<li class="step-row ${s.ok ? 'ok' : 'bad'}"><span class="ic">${s.ok ? '✓' : '✕'}</span><span class="nm">${esc(s.name)}${s.error ? `<em>${esc(s.error)}</em>` : ''}</span><span class="dur mono">${fmtMs(s.durationMs)}</span></li>`,
        )
        .join('')
    : '<li class="muted">Waiting for the Anchor run…</li>';
  const shot = safeHref(run?.screenshotUrl)
    ? `<figure class="shot"><img src="${esc(run?.screenshotUrl)}" alt="Screenshot at the point of failure" /><figcaption>screenshot @ failure</figcaption></figure>`
    : '';
  const errorBox = inc.error ? `<div class="errbox"><span class="ic">✕</span><code>${esc(inc.error)}</code></div>` : '';
  const logs = inc.logs.filter((l) => l.level !== 'info');
  const consoleBox = logs.length
    ? `<div class="sec-h">Console</div><pre class="term">${logs.map((l) => `<span class="ln ${l.level === 'error' ? 'err' : 'warn'}">${esc(l.message)}</span>`).join('\n')}</pre>`
    : '';
  const verdict =
    run?.ok === false
      ? `${pill('FLOW FAILED', 'var(--bad)', '✕', true)} <span class="muted sm">failed at step ${failIdx >= 0 ? failIdx + 1 : '?'} of ${steps.length || '?'}</span>`
      : run?.ok === true
        ? pill('FLOW PASSED', 'var(--ok)', '✓')
        : pill('RUNNING', 'var(--info)', '●');
  return `<ol class="steps-list">${rows}</ol>${shot}${errorBox}${consoleBox}<div class="row-gap">${verdict}</div>`;
}

function triageBody(inc: IncidentView): string {
  const t = inc.triage;
  if (!t) return waiting('Classifying the failure…');
  const guard = t.safe ? pill('GUARDRAILS CLEAN', 'var(--ok)', '✓') : pill('BLOCKED BY GUARDRAIL', 'var(--bad)', '✕', true);
  const sev = SEVERITY_INFO[t.severity];
  return `<div class="row-gap">${guard}<span class="muted sm mono">${esc(t.guard)}</span></div>
    ${t.reason ? `<p class="sm muted">${esc(t.reason)}</p>` : ''}
    <div class="row-gap">${pill(sev.label, sev.css)}<span class="cap">category</span><b class="mono sm">${esc(t.category)}</b></div>
    <p class="summary">${esc(t.summary)}</p>`;
}

function recallBody(inc: IncidentView): string {
  const m = inc.matches;
  if (!m) return waiting('Searching memory for similar bugs…');
  if (m.matches.length === 0) {
    return '<div class="empty-note">No similar past bug. This one is new, so the agent works from first principles.</div>';
  }
  const top = m.matches[0];
  const seen =
    top.similarity >= 0.8 && top.fixSummary
      ? `<div class="seen"><div class="row-gap">${pill('SEEN BEFORE', 'var(--surreal)', undefined, true)}<b class="mono">bug ${esc(top.bugId)}</b><span class="grow"></span><span class="mono">${top.similarity.toFixed(2)} match</span></div>
         <p class="sm">Fixed before by: <b>${esc(top.fixSummary)}</b>${top.score !== undefined ? ` · judge ${Math.round(top.score)}/100` : ''}</p></div>`
      : '';
  const rows = m.matches
    .map((x) => `<div class="match"><div class="bar-row"><div class="bar-row-h"><span>bug ${esc(x.bugId)} · ${esc(x.signature)}</span><span class="mono">${x.similarity.toFixed(2)}</span></div><div class="bar" role="img" aria-label="similarity ${x.similarity.toFixed(2)}"><i style="--w:${(Math.max(0, Math.min(1, x.similarity)) * 100).toFixed(1)}%;--c:var(--surreal)"></i></div></div></div>`)
    .join('');
  return `${seen}<div class="sec-h">Similar bugs</div>${rows}`;
}

function sandboxBody(inc: IncidentView, phase: 'reproduce' | 'verify'): string {
  const lines = inc.sandboxLogs.filter((l) => l.phase === phase);
  const res = [...inc.results].reverse().find((r) => r.phase === phase);
  const sb = inc.sandbox;
  const grid = `<div class="meta-grid">
    <div><span class="cap">sandbox</span><b class="mono">${esc(short(sb?.id, 16))}</b></div>
    <div><span class="cap">provider</span><b class="mono">${esc(sb?.provider ?? '—')}</b></div>
    <div><span class="cap">run</span><b class="mono">${res ? (res.passed ? 'passed' : 'failed') : 'running'}</b></div>
    <div><span class="cap">time</span><b class="mono">${res ? fmtMs(res.durationMs) : '…'}</b></div></div>`;
  const term = `<pre class="term">${
    lines.length
      ? lines.map((l) => `<span class="ln ${termClass(l.line)}">${esc(l.line)}</span>`).join('\n')
      : '<span class="ln dim">waiting for sandbox output…</span>'
  }</pre>`;
  let verdict = '';
  if (res) {
    if (phase === 'reproduce') verdict = res.passed ? pill('NOT REPRODUCED', 'var(--warn)', '!') : pill('REPRODUCED', 'var(--bad)', '✕', true);
    else verdict = res.passed ? pill('VERIFIED · GREEN', 'var(--ok)', '✓') : pill('STILL FAILING', 'var(--bad)', '✕', true);
  }
  const preview = safeHref(res?.previewUrl);
  const link = preview ? `<a class="btn sm" href="${esc(preview)}" target="_blank" rel="noopener noreferrer">Preview ↗</a>` : '';
  const summary = res ? `<p class="sm">${esc(res.summary)}</p>` : '';
  return `${grid}${term}<div class="row-gap">${verdict}${link}</div>${summary}`;
}

function patchBody(inc: IncidentView): string {
  const tail = '<div class="sec-h">Thinking</div><div class="thinking" data-thinking></div>';
  const rejections = inc.rejections.length
    ? `<ul class="list">${inc.rejections.map((r) => `<li class="warn-row"><span class="ic">!</span>attempt ${r.attempt} rejected: ${esc(r.reason)}</li>`).join('')}</ul>`
    : '';
  const p = inc.patches[inc.patches.length - 1];
  if (!p) return `${tail}${rejections}${waiting('Drafting the patch…')}`;
  const reasons = p.reasoning
    .map((r, i) => `<li class="rs"><span class="num">${i + 1}</span><span>${esc(r)}</span></li>`)
    .join('');
  return `${tail}
    <p class="patch-sum"><b>${esc(p.summary)}</b></p>
    <ol class="reasons">${reasons}</ol>
    <div class="row-gap conf"><span class="cap">confidence</span>${meterHtml(p.confidence, 'var(--aws)', `Confidence ${p.confidence.toFixed(2)}`)}<span class="mono">${p.confidence.toFixed(2)}</span></div>
    <div class="files">${p.files.map((f) => `<span class="file mono">${esc(f)}</span>`).join('')}</div>
    ${diffHtml(p.diff)}
    ${rejections}`;
}

function gateBody(inc: IncidentView, env: StageEnv): string {
  const g = inc.gate;
  if (!g) return waiting('Scoring risk against the autonomy policy…');
  const band = g.risk < 40 ? { label: 'low', css: 'var(--ok)' } : g.risk < 70 ? { label: 'medium', css: 'var(--warn)' } : { label: 'high', css: 'var(--bad)' };
  let decision: string;
  if (g.decision === 'auto') decision = pill('AUTO-APPROVED BY POLICY', 'var(--ok)', '✓');
  else if (g.decision === 'blocked') decision = pill('BLOCKED BY POLICY', 'var(--bad)', '✕', true);
  else if (g.resolved) decision = g.approved ? pill('APPROVED BY A REVIEWER', 'var(--ok)', '✓') : pill('REJECTED BY A REVIEWER', 'var(--bad)', '✕', true);
  else decision = pill('NEEDS APPROVAL', 'var(--warn)', '!');
  const waitingOnHuman = g.decision === 'needs_approval' && !g.resolved;
  const busy = env.busy(`approve:${inc.id}`);
  const actions = waitingOnHuman
    ? `<div class="row-gap actions"><button class="btn danger" data-act="approve" data-id="${esc(inc.id)}" data-approved="false"${busy ? ' disabled' : ''}>Reject</button><span class="grow"></span><button class="btn primary" data-act="approve" data-id="${esc(inc.id)}" data-approved="true"${busy ? ' disabled' : ''}>Approve &amp; deploy</button></div>`
    : '';
  return `<div class="row-gap"><span class="cap">risk</span><span class="grow"></span><b class="mono">${g.risk} / 100 · ${band.label}</b></div>
    ${meterHtml(g.risk / 100, band.css, `Risk ${g.risk} of 100, ${band.label}`)}
    <div class="row-gap">${decision}</div>
    <ul class="list">${g.reasons.map((r) => `<li><span class="dot-b">•</span>${esc(r)}</li>`).join('')}</ul>
    ${g.preScore !== undefined ? `<p class="sm muted">Pre-deploy judge score ${g.preScore.toFixed(2)}</p>` : ''}
    ${actions}`;
}

function deployBody(inc: IncidentView, env: StageEnv): string {
  const last = inc.deploys[inc.deploys.length - 1];
  if (!last) return waiting('Waiting for the canary…');
  const busy = env.busy('rollback');
  const phases = inc.deploys
    .map((d) => {
      const link = safeHref(d.url);
      return `<li class="${d.ok ? 'ok' : 'bad'}"><span class="ic">${d.ok ? '✓' : '✕'}</span><span class="nm">${esc(PHASE_LABEL[d.phase] ?? d.phase)}${d.detail ? `<em>${esc(d.detail)}</em>` : ''}</span>${link ? `<a class="lnk" href="${esc(link)}" target="_blank" rel="noopener noreferrer">open ↗</a>` : ''}</li>`;
    })
    .join('');
  const rolledBack = inc.deploys.some((d) => d.phase === 'rolled_back');
  return `<div class="flip">${inc.versionBefore ? `<span class="old mono">${esc(inc.versionBefore)}</span><span class="arrow">→</span>` : ''}<b class="mono new">${esc(last.version)}</b></div>
    <ol class="phases">${phases}</ol>
    ${rolledBack ? `<div class="errbox"><span class="ic">↶</span><code>rolled back to ${esc(inc.versionBefore ?? 'the previous version')}</code></div>` : ''}
    <div class="row-gap"><span class="muted sm mono">${esc(last.provider)}</span><span class="grow"></span><button class="btn danger sm" data-act="rollback"${busy ? ' disabled' : ''}>↶ Rollback</button></div>`;
}

function miniTrace(inc: IncidentView, now: number): string {
  const t0 = inc.openedAt;
  const end = inc.closedAt ?? now;
  const total = Math.max(1, end - t0);
  const rows = STAGES.map((s) => {
    const v = inc.stages[s];
    if (v.startedAt === undefined) return '';
    const a = v.startedAt - t0;
    const b = (v.endedAt ?? end) - t0;
    const left = Math.max(0, (a / total) * 100);
    const width = Math.max(0.8, ((b - a) / total) * 100);
    const css = SPONSOR_INFO[STAGE_SPONSOR[s]].css;
    return `<div class="mt-row"><span class="mt-name">${esc(STAGE_LABEL[s])}</span><div class="mt-track"><i style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${css}"></i></div><span class="mt-dur mono">${fmtMs(b - a)}</span></div>`;
  }).join('');
  const seen = new Map<string, string>();
  for (const s of STAGES) {
    const sp = SPONSOR_INFO[STAGE_SPONSOR[s]];
    seen.set(sp.css, seen.has(sp.css) ? seen.get(sp.css) ?? sp.label : sp.label);
  }
  const legend = [...seen.entries()]
    .map(([css, label]) => `<span class="lg"><i class="sw" style="background:${css}"></i>${esc(label)}</span>`)
    .join('');
  return `<div class="mini-trace"><div class="sec-h">Trace · ${fmtMs(total)}</div><div class="legend">${legend}</div>${rows}</div>`;
}

function judgeBody(inc: IncidentView, now: number): string {
  const ev = inc.evalResult;
  if (!ev) return waiting('Judge is scoring the trace…');
  const trace = safeHref(ev.traceUrl ?? inc.traceUrl);
  return `<div class="judge-top">${scoreRingHtml(ev.score)}
      <div class="col"><span class="cap">fix quality</span><b class="verdict">${esc(ev.verdict)}</b><span class="sm muted">LLM judge · ${esc(ev.model)}</span>
      ${trace ? `<a class="btn sm" href="${esc(trace)}" target="_blank" rel="noopener noreferrer">Open trace in Arize ↗</a>` : ''}</div></div>
    <div class="rubric">${rubricHtml(ev.rubric)}</div>
    ${miniTrace(inc, now)}`;
}

function learnBody(inc: IncidentView): string {
  const parts: string[] = [];
  if (inc.learned) {
    parts.push(`<p>Wrote <b class="mono">bug ${esc(inc.learned.bugId)}</b> → <b class="mono">fix ${esc(inc.learned.fixId)}</b> to the memory graph (${inc.learned.edges} new links).</p>`);
  } else {
    parts.push(waiting('Writing the bug → fix link…'));
  }
  if (inc.closedAt !== undefined) {
    const st = STATUS_INFO[inc.status];
    parts.push(`<div class="row-gap closed">${pill(st.label, st.css, st.icon)}<span class="sm">closed after ${fmtMs(inc.durationMs)}${inc.score !== undefined ? ` · score ${Math.round(inc.score)}` : ''}</span></div>`);
    if (inc.summary) parts.push(`<p class="sm muted">${esc(inc.summary)}</p>`);
  }
  return parts.join('');
}

/** Render one stage of the incident into the context panel. */
export function renderStage(i: number, inc: IncidentView, env: StageEnv): Rendered {
  const s = STAGES[i];
  switch (s) {
    case 'detect': {
      const run = pickDetectRun(inc);
      return { head: head(i, run?.sessionId ? `session ${short(run.sessionId, 12)}` : run?.flowId ?? ''), body: detectBody(inc) };
    }
    case 'triage':
      return { head: head(i, inc.triage ? inc.triage.category : ''), body: triageBody(inc) };
    case 'recall':
      return { head: head(i, inc.matches ? `${inc.matches.matches.length} match${inc.matches.matches.length === 1 ? '' : 'es'}` : ''), body: recallBody(inc) };
    case 'reproduce':
      return { head: head(i, inc.sandbox ? short(inc.sandbox.id, 12) : 'booting'), body: sandboxBody(inc, 'reproduce') };
    case 'patch': {
      const p = inc.patches[inc.patches.length - 1];
      return { head: head(i, p ? short(p.model, 22) : ''), body: patchBody(inc) };
    }
    case 'verify':
      return { head: head(i, inc.sandbox ? short(inc.sandbox.id, 12) : ''), body: sandboxBody(inc, 'verify') };
    case 'gate':
      return { head: head(i, inc.gate ? `risk ${inc.gate.risk}` : ''), body: gateBody(inc, env) };
    case 'deploy': {
      const last = inc.deploys[inc.deploys.length - 1];
      return { head: head(i, last ? last.version : ''), body: deployBody(inc, env) };
    }
    case 'judge':
      return { head: head(i, inc.evalResult ? `score ${Math.round(inc.evalResult.score)}` : ''), body: judgeBody(inc, env.now) };
    case 'learn':
      return { head: head(i, inc.learned ? `bug ${inc.learned.bugId}` : ''), body: learnBody(inc) };
    default:
      return { head: '', body: '' };
  }
}

/** Calm state: nothing is healing. Shows the patrol: every flow with its recent history. */
export function renderCalm(flows: FlowInfo[], nextAt: number | undefined, last: IncidentView | undefined, env: StageEnv): Rendered {
  const next = nextAt !== undefined ? `next patrol in ${fmtClock(Math.max(0, nextAt - env.now))}` : 'patrolling';
  const rows = flows
    .map((f) => {
      const status = f.lastRun
        ? `<span class="${f.lastRun.ok ? 'ok' : 'bad'} sm">${f.lastRun.ok ? '✓ passing' : '✕ failing'}</span>`
        : '<span class="muted sm">not run yet</span>';
      return `<li class="flow-row"><div class="fr-h"><b>${esc(f.name)}</b>${f.critical ? '<span class="tag">critical</span>' : ''}<span class="grow"></span>${status}</div>${stripHtml(f.history)}</li>`;
    })
    .join('');
  const lastCard = last
    ? `<div class="card-note">Last incident <b class="mono">#${esc(last.id)}</b> · ${esc(STATUS_INFO[last.status].label.toLowerCase())}${last.durationMs !== undefined ? ` in ${fmtMs(last.durationMs)}` : ''}</div>`
    : '';
  return {
    head: `${pill('Anchor', SPONSOR_INFO.anchor.css, '●')}<b class="ctx-title">Patrol · ${flows.length} flows</b><span class="grow"></span><span class="ctx-meta mono">${esc(next)}</span>`,
    body: `<ul class="flow-list">${rows || '<li class="muted">No flows configured.</li>'}</ul>${lastCard}`,
  };
}

/** The streamed thinking text, shown as the tail of the patch panel. */
export function thinkingTail(inc: IncidentView | undefined): string {
  if (!inc) return '';
  let text = '';
  for (const c of inc.llm) if (c.kind === 'thinking') text += c.text;
  return text.length > 420 ? `…${text.slice(-420)}` : text;
}
