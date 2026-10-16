/**
 * createTelemetry(): one OpenTelemetry tracer provider per process, never registered globally.
 * Every span is recorded in-process (for the dashboard waterfall). When Arize is configured the
 * spans are also exported over OTLP/HTTP through a BatchSpanProcessor.
 */
import {
  ROOT_CONTEXT,
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  TraceFlags,
  context,
  trace,
  type Span as OtelSpan,
  type Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OpenInferenceSpanKind, SemanticConventions } from '@arizeai/openinference-semantic-conventions';
import {
  createLogger,
  loadConfig,
  type Attr,
  type HealOpsConfig,
  type RecordedSpan,
  type SpanHandle,
  type Telemetry,
} from '@healops/shared';
import { TraceRecorder } from './recorder.js';

type StartSpanOptions = NonNullable<Parameters<Telemetry['startSpan']>[1]>;
type ExportResult = Parameters<Parameters<SpanExporter['export']>[1]>[0];

/** OpenTelemetry ExportResultCode.SUCCESS. Compared by value so @opentelemetry/core need not be imported. */
const EXPORT_SUCCESS = 0;

const logger = createLogger('arize');

/** Outcome of one OTLP export call. */
export interface ExportReport {
  ok: boolean;
  /** OpenTelemetry ExportResultCode: 0 = SUCCESS, 1 = FAILED */
  code: number;
  spans: number;
  durationMs: number;
  /** exporter error text with the API key and space id removed */
  error?: string;
}

export interface TelemetryOptions {
  /** Called after every OTLP export call (Arize provider only). */
  onExport?: (report: ExportReport) => void;
}

/** SpanHandle -> live OpenTelemetry span, so child spans can be parented on a handle. */
const liveSpans = new WeakMap<SpanHandle, OtelSpan>();

export function createTelemetry(cfg: HealOpsConfig = loadConfig(), opts: TelemetryOptions = {}): Telemetry {
  const { arize } = cfg;
  const credentials =
    arize.enabled && arize.spaceId && arize.apiKey ? { spaceId: arize.spaceId, apiKey: arize.apiKey } : undefined;
  if (arize.enabled && !credentials) {
    logger.warn('Arize is enabled but space id / api key are missing; recording spans in-process only');
  }

  const recorder = new TraceRecorder();
  const processors: SpanProcessor[] = [recorder];
  let resource = resourceFromAttributes({ 'service.name': 'healops-agent' });

  const secrets = credentials ? [credentials.spaceId, credentials.apiKey] : [];
  const scrub = (text: string): string => redact(text, secrets);
  if (credentials) {
    const onReport = (report: ExportReport): void => {
      if (!report.ok) logger.warn(`OTLP export failed for ${report.spans} span(s): ${report.error ?? 'unknown error'}`);
      opts.onExport?.(report);
    };
    const exporter = new OTLPTraceExporter({
      url: arize.endpoint,
      headers: { space_id: credentials.spaceId, api_key: credentials.apiKey },
    });
    processors.push(new BatchSpanProcessor(new ReportingExporter(exporter, onReport, scrub)));
    resource = resourceFromAttributes({
      'service.name': 'healops-agent',
      model_id: arize.projectName,
      model_version: 'v1',
      'openinference.project.name': arize.projectName,
    });
    logger.info(`exporting spans to ${arize.endpoint} (project "${arize.projectName}")`);
  }

  // Not registered globally: nothing else in the process sees this provider through the OTel API.
  const sdk = new NodeTracerProvider({ resource, spanProcessors: processors });
  return new HealOpsTelemetry(credentials ? 'arize' : 'local', sdk, recorder, scrub);
}

class HealOpsTelemetry implements Telemetry {
  private readonly tracer: Tracer;

  constructor(
    readonly provider: 'arize' | 'local',
    private readonly sdk: NodeTracerProvider,
    private readonly recorder: TraceRecorder,
    private readonly scrub: (text: string) => string,
  ) {
    this.tracer = sdk.getTracer('@healops/telemetry');
  }

  startSpan(name: string, opts: StartSpanOptions = {}): SpanHandle {
    const attributes: Record<string, Attr> = {};
    for (const [key, value] of Object.entries(opts.attributes ?? {})) {
      if (value !== undefined) attributes[key] = value;
    }
    // Set last so the span kind always matches the requested kind.
    attributes[SemanticConventions.OPENINFERENCE_SPAN_KIND] = OpenInferenceSpanKind[opts.kind ?? 'CHAIN'];

    const parentContext = opts.parent ? trace.setSpan(context.active(), liveSpanFor(opts.parent)) : ROOT_CONTEXT;
    const span = this.tracer.startSpan(name, { kind: OtelSpanKind.INTERNAL, attributes }, parentContext);
    const handle = new OtelSpanHandle(span);
    liveSpans.set(handle, span);
    return handle;
  }

  traceUrl(_traceId: string): string | undefined {
    // Arize's docs do not document a stable link to a trace in the UI, so no link is produced.
    return undefined;
  }

  spans(traceId: string): RecordedSpan[] {
    return this.recorder.spans(traceId);
  }

  /** Never throws: export failures are logged (secrets scrubbed) and reported through onExport. */
  async flush(): Promise<void> {
    await this.settle('flush', () => this.sdk.forceFlush());
  }

  async shutdown(): Promise<void> {
    await this.settle('shutdown', () => this.sdk.shutdown());
  }

  private async settle(op: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      logger.warn(`${op} did not complete cleanly: ${this.scrub(describeError(err))}`);
    }
  }
}

class OtelSpanHandle implements SpanHandle {
  readonly traceId: string;
  readonly spanId: string;

  constructor(private readonly span: OtelSpan) {
    const { traceId, spanId } = span.spanContext();
    this.traceId = traceId;
    this.spanId = spanId;
  }

  setAttributes(attrs: Record<string, Attr | undefined>): void {
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined) this.span.setAttribute(key, value);
    }
  }

  addEvent(name: string, attrs?: Record<string, Attr>): void {
    this.span.addEvent(name, attrs);
  }

  fail(err: unknown): void {
    const error = err instanceof Error ? err : new Error(describeError(err));
    this.span.recordException(error);
    this.span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }

  end(): void {
    this.span.end();
  }
}

/** Wraps the OTLP exporter to report each export result and to scrub secrets from errors. */
class ReportingExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly report: (r: ExportReport) => void,
    private readonly redactText: (text: string) => string,
  ) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    const started = Date.now();
    this.inner.export(spans, (result) => {
      try {
        this.report({
          ok: result.code === EXPORT_SUCCESS,
          code: result.code,
          spans: spans.length,
          durationMs: Date.now() - started,
          error: result.error ? this.redactText(describeError(result.error)) : undefined,
        });
      } catch (err) {
        logger.warn(`export report hook failed: ${describeError(err)}`);
      }
      done(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

function liveSpanFor(parent: SpanHandle): OtelSpan {
  return (
    liveSpans.get(parent) ??
    trace.wrapSpanContext({ traceId: parent.traceId, spanId: parent.spanId, traceFlags: TraceFlags.SAMPLED })
  );
}

function describeError(err: unknown): string {
  if (Array.isArray(err)) return err.map(describeError).join('; ');
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((out, secret) => (secret ? out.split(secret).join('[redacted]') : out), text);
}
