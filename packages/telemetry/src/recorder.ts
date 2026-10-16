/**
 * In-process span store. It is registered as a SpanProcessor on every provider, so the
 * dashboard can draw a waterfall without querying Arize. Keeps the most recently active traces.
 */
import { SpanStatusCode, type Attributes, type Context, type HrTime } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SemanticConventions } from '@arizeai/openinference-semantic-conventions';
import type { Attr, RecordedSpan, SpanKind } from '@healops/shared';

export const MAX_RECORDED_TRACES = 200;

const STATUS: Record<number, RecordedSpan['status']> = {
  [SpanStatusCode.UNSET]: 'unset',
  [SpanStatusCode.OK]: 'ok',
  [SpanStatusCode.ERROR]: 'error',
};

export class TraceRecorder implements SpanProcessor {
  /** Insertion order doubles as recency: a trace moves to the end whenever it receives a span. */
  private readonly traces = new Map<string, ReadableSpan[]>();

  onStart(span: Span, _parentContext: Context): void {
    const { traceId } = span.spanContext();
    const list = this.traces.get(traceId) ?? [];
    this.traces.delete(traceId);
    this.traces.set(traceId, list);
    list.push(span);
    while (this.traces.size > MAX_RECORDED_TRACES) {
      const oldest = this.traces.keys().next().value;
      if (oldest === undefined) break;
      this.traces.delete(oldest);
    }
  }

  onEnd(_span: ReadableSpan): void {
    // Nothing to do: spans() reads the live span objects, so ended spans are already current.
  }

  spans(traceId: string): RecordedSpan[] {
    return (this.traces.get(traceId) ?? []).map(toRecorded);
  }

  async forceFlush(): Promise<void> {
    // In-memory only; nothing to flush.
  }

  async shutdown(): Promise<void> {
    // Keep recorded spans so the dashboard can still read them after shutdown.
  }
}

function toRecorded(span: ReadableSpan): RecordedSpan {
  const { traceId, spanId } = span.spanContext();
  const attributes = primitiveAttributes(span.attributes);
  return {
    traceId,
    spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    name: span.name,
    kind: (attributes[SemanticConventions.OPENINFERENCE_SPAN_KIND] as SpanKind | undefined) ?? 'CHAIN',
    startMs: toMs(span.startTime),
    endMs: span.ended ? toMs(span.endTime) : undefined,
    status: STATUS[span.status.code] ?? 'unset',
    attributes,
  };
}

function toMs(time: HrTime): number {
  return time[0] * 1e3 + time[1] / 1e6;
}

function primitiveAttributes(attrs: Attributes): Record<string, Attr> {
  const out: Record<string, Attr> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}
