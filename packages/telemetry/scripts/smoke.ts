/**
 * Smoke test for @healops/telemetry: one incident trace exported to Arize.
 *   npx tsx packages/telemetry/scripts/smoke.ts
 * Exit 0 only if the in-process spans are correct AND every OTLP export returned SUCCESS.
 */
import { loadConfig } from '@healops/shared';
import { createTelemetry, evalAttributes, llmAttributes, type ExportReport } from '../src/index.js';

let failed = 0;

function check(ok: boolean, label: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.arize.enabled) throw new Error('ARIZE_API_KEY and ARIZE_SPACE_ID must be set in .env');

  const exportReports: ExportReport[] = [];
  const telemetry = createTelemetry(cfg, {
    onExport: (r) => {
      exportReports.push(r);
      const detail = r.error ? ` error: ${r.error}` : '';
      console.log(`[smoke] OTLP export ResultCode=${r.code} (${r.ok ? 'SUCCESS' : 'FAILED'}) spans=${r.spans} ${r.durationMs}ms${detail}`);
    },
  });
  check(telemetry.provider === 'arize', 'provider is "arize"');

  try {
    const incident = telemetry.startSpan('incident smoke-test', {
      kind: 'AGENT',
      attributes: { 'healops.incident_id': `smoke_${Date.now().toString(36)}` },
    });
    const detect = telemetry.startSpan('detect', {
      parent: incident,
      kind: 'CHAIN',
      attributes: { 'healops.stage': 'detect' },
    });
    detect.end();

    const patch = telemetry.startSpan('patch', {
      parent: incident,
      kind: 'LLM',
      attributes: llmAttributes({
        model: cfg.llm.patchModel,
        provider: cfg.llm.provider,
        inputTokens: 1200,
        outputTokens: 340,
        input: 'smoke test: the cart subtotal is undefined',
        output: 'smoke test: guard the undefined cart line',
        invocation: { max_tokens: 4096 },
      }),
    });
    patch.end();

    const judge = telemetry.startSpan('judge', {
      parent: incident,
      kind: 'EVALUATOR',
      attributes: evalAttributes('fix_quality', { score: 0.93, label: 'excellent' }),
    });
    judge.end();
    incident.end();

    const traceId = incident.traceId;
    console.log(`[smoke] traceId=${traceId}`);

    // 1. In-process spans (what the dashboard waterfall reads).
    const spans = telemetry.spans(traceId);
    check(spans.length === 4, `spans(traceId) returns 4 spans (got ${spans.length})`);
    const root = spans.find((s) => s.name === 'incident smoke-test');
    check(root !== undefined && root.kind === 'AGENT' && root.parentSpanId === undefined, 'root is AGENT with no parent');
    for (const [name, kind] of [
      ['detect', 'CHAIN'],
      ['patch', 'LLM'],
      ['judge', 'EVALUATOR'],
    ] as const) {
      const span = spans.find((s) => s.name === name);
      const childOfRoot = span !== undefined && root !== undefined && span.parentSpanId === root.spanId;
      check(span?.kind === kind && childOfRoot, `${name} is ${kind} and a child of the root`);
    }
    check(spans.every((s) => s.endMs !== undefined && s.endMs >= s.startMs), 'every span has end >= start');
    check(
      spans.every((s) => s.attributes['openinference.span.kind'] === s.kind),
      'openinference.span.kind matches each span kind',
    );
    const patchAttrs = spans.find((s) => s.name === 'patch')?.attributes ?? {};
    check(
      patchAttrs['llm.token_count.prompt'] === 1200 &&
        patchAttrs['llm.token_count.completion'] === 340 &&
        patchAttrs['llm.token_count.total'] === 1540,
      'patch LLM span carries prompt/completion/total token counts',
    );
    check(
      spans.find((s) => s.name === 'judge')?.attributes['eval.fix_quality.score'] === 0.93,
      'judge span carries eval.fix_quality.score = 0.93',
    );

    // 2. Export to Arize.
    await telemetry.flush();
    const exportedSpans = exportReports.reduce((n, r) => n + r.spans, 0);
    check(
      exportReports.length > 0 && exportReports.every((r) => r.ok),
      `every OTLP export returned SUCCESS (${exportReports.length} call(s))`,
    );
    check(exportedSpans === 4, `all 4 spans reached the exporter (got ${exportedSpans})`);

    console.log(`[smoke] traceId: ${traceId}`);
    if (exportReports.length > 0 && exportReports.every((r) => r.ok)) {
      console.log(
        `[smoke] find it: Arize AX -> project "${cfg.arize.projectName}" -> Tracing; ` +
          `search context.trace_id = '${traceId}' or look for the root span "incident smoke-test".`,
      );
    }
  } finally {
    await telemetry.shutdown();
  }
}

main()
  .then(() => {
    console.log(failed === 0 ? '[smoke] PASS' : `[smoke] FAIL (${failed} check(s) failed)`);
    process.exitCode = failed === 0 ? 0 : 1;
  })
  .catch((err: unknown) => {
    console.error('[smoke] crashed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
