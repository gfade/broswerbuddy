import {
  STAGE_SPONSOR, STAGES, errorMessage,
  type Attr, type SpanHandle, type SpanKind, type Stage,
} from '@healops/shared';
import { Closed, soft, softSync, type Heal } from './context.js';

/** What a stage body can set before it returns or throws. */
export interface StageCtl {
  status?: 'completed' | 'failed';
  detail?: string;
  span?: SpanHandle;
}

/** Stop the heal if a human took over. Called before every stage and approval resolution. */
export function checkpoint(h: Heal): void {
  if (h.rec.abort) throw new Closed('escalated', 'human took over');
}

async function finish(h: Heal, name: Stage, status: 'completed' | 'failed', detail?: string): Promise<void> {
  h.hub.emit({ type: 'stage.changed', incidentId: h.rec.id, stage: name, sponsor: STAGE_SPONSOR[name], status, detail });
  await soft('memory.recordTransition', () =>
    h.hub.deps.memory.recordTransition(h.rec.id, name, status, detail ? { detail } : undefined),
  );
}

/**
 * Run one pipeline stage: checkpoint, emit started, open a child span, run the body,
 * then emit completed or failed. A `Closed` thrown by the body ends the pipeline
 * (the stage itself is still reported as completed unless the body set status 'failed').
 */
export async function stage<T>(
  h: Heal,
  name: Stage,
  kind: SpanKind,
  startDetail: string | undefined,
  body: (ctl: StageCtl) => Promise<T>,
  attrs: Record<string, Attr | undefined> = {},
): Promise<T> {
  checkpoint(h);
  h.started.add(name);
  const ctl: StageCtl = {};
  const telemetry = h.hub.deps.telemetry;
  ctl.span = softSync('telemetry.startSpan', () =>
    telemetry.startSpan(name, {
      parent: h.rootSpan,
      kind,
      attributes: {
        'healops.stage': name,
        'healops.sponsor': STAGE_SPONSOR[name],
        'healops.incident_id': h.rec.id,
        ...attrs,
      },
    }),
  );
  h.hub.emit({ type: 'stage.changed', incidentId: h.rec.id, stage: name, sponsor: STAGE_SPONSOR[name], status: 'started', detail: startDetail });
  await soft('memory.recordTransition', () =>
    h.hub.deps.memory.recordTransition(h.rec.id, name, 'started', startDetail ? { detail: startDetail } : undefined),
  );
  try {
    const value = await body(ctl);
    await finish(h, name, ctl.status ?? 'completed', ctl.detail);
    return value;
  } catch (err) {
    if (err instanceof Closed) {
      await finish(h, name, ctl.status ?? 'completed', ctl.detail ?? err.message);
    } else {
      softSync('span.fail', () => ctl.span?.fail(err));
      await finish(h, name, 'failed', ctl.detail ?? errorMessage(err));
    }
    throw err;
  } finally {
    softSync('span.end', () => ctl.span?.end());
  }
}

/** When an incident closes early, report the stages that never ran as skipped. */
export function skipRemaining(h: Heal, reason: string): void {
  for (const s of STAGES) {
    if (h.started.has(s)) continue;
    h.hub.emit({ type: 'stage.changed', incidentId: h.rec.id, stage: s, sponsor: STAGE_SPONSOR[s], status: 'skipped', detail: reason });
  }
}
