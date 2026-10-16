# HealOps: Self-Healing QA Engineer (hackathon project)

An agent that finds bugs in a web app and fixes them on its own. It patrols a demo store with a cloud browser. When a flow breaks it runs a pipeline: triage → recall → reproduce → patch → verify → gate → deploy → judge → learn. Each stage emits typed events, and a mission-control dashboard renders them live.

Sponsors, one per stage: **Anchor Browser** (detect), **AWS Bedrock / Claude** (triage, patch, judge), **SurrealDB** (memory graph + vectors), **Daytona** (sandbox reproduce/verify), **AWS** (deploy/hosting), **Arize** (OpenTelemetry traces + evals). Every sponsor has a local fallback, so the app also runs with no keys.

## Layout (npm workspaces, TypeScript ESM, run with `tsx`, no build step for libs)
| Path | Package | Status (2026-10-16) |
|---|---|---|
| packages/shared | contracts: `types.ts`, `events.ts` (IncidentEvent union = UI contract), `config.ts` (.env → typed config), `util.ts` | ✅ done |
| packages/llm | `createLLM()`: Opus 5.5 patches (streamed, summarised thinking, structured output), judge/triage/screen, Titan embeddings | ✅ done, live-tested (`npx tsx packages/llm/scripts/smoke.ts`) |
| packages/telemetry | `createTelemetry()`: OTel → Arize + in-process span recorder | ✅ done, export to Arize verified |
| packages/deploy | `createDeployer()`: local static host with canary/promote/rollback; S3 implementation + `provisionS3Site()` (never auto-called) | ✅ done (29/29 smoke) |
| apps/demo-store | static "LOL Store" site, 3 seeded bugs (`seeds/`), Playwright flows, node:test tests, `TEST_COMMAND = node --test tests/*.mjs` | ✅ done (34/34 smoke) |
| apps/widget | 🐞 flag-a-bug widget → `dist/healops.js` | ✅ done |
| packages/anchor | `createBrowserRunner()`: Anchor sessions over CDP + local Chromium fallback; sets the Daytona preview header | ✅ done (36/36 smoke, live Anchor session ~2s create) |
| packages/daytona | `createSandboxProvider()`: Daytona sandboxes (public preview, default snapshot has Node 25) + local fallback | ✅ done (live: create 1.6s; preview warning confirmed, header bypass works) |
| packages/memory | `createMemory()`, `seedHistory()`, `hashEmbed()`: SurrealDB (cloud or embedded `@surrealdb/node`) + in-memory fallback | ⏳ verify |
| packages/agent | `createRuntime(deps)`: the orchestrator (implements `HealOpsRuntime`) | ⏳ verify |
| apps/server | HTTP `/api/*` + WebSocket `/ws` + static hosting; `HEALOPS_FAKE=1` fake runtime | ⏳ verify |
| apps/dashboard | Vite + vanilla TS mission control (`?demo=1` plays a scripted incident) | ⏳ verify |
| scripts/ | `import-apis.mjs`, `e2e.ts` (needs wire.ts), `doctor.ts` (`npm run doctor`: 11/15 pass; the fails are the expected Haiku 403 and no Surreal Cloud instance), `tunnel.mjs` (`npm run tunnel`) | ✅ |

Design reference for the UI: `docs/design/frontend.html`, `docs/design/backend.html` (Figma-style boards; open in a browser).

## Verify each package (definition of done)
```bash
npx tsc -p <package dir>               # must be 0 errors
npx tsx <package>/scripts/smoke.ts     # each package has a smoke test (widget: node apps/widget/scripts/smoke.mjs)
npx tsx packages/agent/scripts/simulate.ts   # orchestrator with fakes
```

## Remaining work (in order)
1. Check that every ⏳ package typechecks and its smoke test passes; fix what doesn't.
2. Replace the placeholder `apps/server/src/wire.ts` with the real wiring:
```ts
import { loadConfig, type HealOpsRuntime } from '@healops/shared';
import { createLLM } from '@healops/llm';
import { createBrowserRunner } from '@healops/anchor';
import { createSandboxProvider } from '@healops/daytona';
import { createMemory, seedHistory } from '@healops/memory';
import { createTelemetry } from '@healops/telemetry';
import { createDeployer } from '@healops/deploy';
import { createRuntime } from '@healops/agent';
import { loadSite, sandboxFiles, seeds, applySeed, DEFAULT_SEED, SITE_VERSION, TEST_COMMAND } from '@healops/demo-store';
import { flows } from '@healops/demo-store/flows';

export async function createHealOps(): Promise<HealOpsRuntime> {
  const config = loadConfig();
  return createRuntime({
    config, llm: createLLM(config), browser: createBrowserRunner(config),
    sandboxes: createSandboxProvider(config), memory: await createMemory(config),
    telemetry: createTelemetry(config), deployer: createDeployer(config),
    site: { version: SITE_VERSION, loadSite, sandboxFiles, testCommand: TEST_COMMAND, seeds, applySeed,
            defaultSeed: process.env.HEALOPS_INITIAL_SEED ?? DEFAULT_SEED },
    flows, seedHistory,
  });
}
```
   Then add the adapter packages to `apps/server/package.json` dependencies (`"@healops/llm": "*"`, …).
3. `npx tsx scripts/e2e.ts checkout-discount` must end with **HEALED** and the re-check flow passing (also try `signup-plus-email` and `cart-overlay`).
4. `npm run build` (widget + dashboard), then `npm run dev`: the dashboard runs on :5173, the API on :8787, and the store on :4000. Click "Break it again", then "Run checkout now", and watch it heal.
5. Public reachability for Anchor's cloud browser. Either run `npm run tunnel -- --write-env` (cloudflared), or host the store on S3: `provisionS3Site()` + `HEALOPS_S3_BUCKET`. Creating AWS resources is the user's decision, so ask first.
6. Polish: README, demo script, root `npm run typecheck` clean.

## Environment facts (learned the hard way)
- **Bedrock (workshop account, us-west-2):** Claude is served only through cross-region inference profiles, so use `AnthropicBedrock` (the bedrock-runtime client from `@anthropic-ai/bedrock-sdk`) with `us.anthropic.claude-opus-5-5`. The Mantle endpoint returns 404 here. `us.anthropic.claude-haiku-5-5` returns 403 (private marketplace), so the LLM layer automatically switches judge/triage/screen to `us.anthropic.claude-sonnet-5-5`. Titan embeddings v2 work (256 dims).
- **AWS credentials are temporary** (Workshop Studio `WSParticipantRole`). When calls start failing, refresh the `AWS_*` values.
- **SurrealDB:** `SURREAL_CLOUD_TOKEN` (sdbp_…) is a read-only control-plane token, never a DB credential. The org has no instance, so memory runs on the embedded engine (`.healops/surreal`). To use the cloud, create an instance and set `SURREAL_URL`, `SURREAL_USER` and `SURREAL_PASS`.
- **Arize:** space "Default Space", ID `U3BhY2U6NTY4OTY6RGpuSQ==`, project `healops`. OTLP endpoint `https://otlp.arize.com/v1/traces` with headers `space_id` + `api_key`.
- **Daytona:** preview links show a warning page to browsers unless the request carries the header `X-Daytona-Skip-Preview-Warning: true`. The browser runner must set it.
- **Anchor's cloud browser can't reach localhost.** Patrols against a local store fall back to local Chromium unless `HEALOPS_PUBLIC_STORE_URL` is set.
- Claude API rules used: the patch call streams with `thinking: {type:'adaptive', display:'summarized'}` and `output_config: {effort:'high', format: betaZodOutputFormat(...)}`. Fast calls use `messages.parse` + `zodOutputFormat`. No prefill, no forced tool_choice. The first-party API uses `fallbacks:'default'`; Bedrock retries a refusal on Opus 4.8.

## Running in Claude Code cloud (Linux)
- Setup script: `bash scripts/cloud-setup.sh` (npm ci + Playwright Chromium with system deps).
- Secrets are **never committed**. Put the variables from `.env.example` into the cloud environment's environment variables, or create `.env` in the session. Locally, `npm run import-apis` builds `.env` from `../apis.txt`.
- Network: sponsor APIs need outbound access to api.anchorbrowser.io, connect.anchorbrowser.io, app.daytona.io (+ Daytona proxy domains), bedrock-runtime.us-west-2.amazonaws.com, sts/s3 amazonaws.com, otlp.arize.com, app.arize.com. Use "full" network access, or allowlist these domains.
- Without keys everything still runs in local-fallback mode (`HEALOPS_LLM_PROVIDER=offline` uses canned fixes).

## Conventions
- Code against `packages/shared` interfaces; adapters live in their own package; the agent receives deps by injection.
- Never print secret values (log only "key present").
- Relative imports use the `.js` extension; ESM only; no `__dirname`.
- Working files go in `.healops/` (gitignored), never in os.tmpdir().
