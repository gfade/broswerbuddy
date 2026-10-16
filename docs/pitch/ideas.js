// Sponsor registry + the 6 build ideas.
// Log lines: prefix "+" = success, "!" = failure, "~" = warning, otherwise neutral.
const SPONSORS = {
  anchor:  { name: 'Anchor Browser', short: 'Anchor',    c: 'var(--anchor)',  url: 'https://anchorbrowser.io' },
  daytona: { name: 'Daytona',        short: 'Daytona',   c: 'var(--daytona)', url: 'https://www.daytona.io' },
  aws:     { name: 'AWS Bedrock',    short: 'AWS',       c: 'var(--aws)',     url: 'https://aws.amazon.com/bedrock/' },
  surreal: { name: 'SurrealDB',      short: 'SurrealDB', c: 'var(--surreal)', url: 'https://surrealdb.com' },
  arize:   { name: 'Arize',          short: 'Arize',     c: 'var(--arize)',   url: 'https://arize.com' }
};

const IDEAS = [
{
  title: 'Key-Flow Patrol', c: 'var(--anchor)', badge: 'Top pick', score: 93,
  short: 'Anchor clicks signup, login and checkout around the clock. When a flow breaks, the agent reproduces it, patches it and redeploys on its own.',
  desc: 'The core loop from the whiteboard: Anchor clicks key flows, and if one breaks, Daytona reproduces it, SurrealDB remembers past bugs as a graph, and Arize traces the reasoning and grades the fix.',
  roles: {
    anchor: 'Runs key flows on a schedule and records the failure',
    daytona: 'Clones the repo and replays the failing flow',
    aws: 'Bedrock writes the patch; AWS hosts the app',
    surreal: 'Links bug → file → fix in a graph',
    arize: 'Traces each step and scores the fix'
  },
  steps: [
    ['anchor', 'Patrol key flows', 'Headless session clicks /checkout',
      ['> anchor.sessions.create({ recording: true })', '> flow "checkout" step 3/5 ...', '! TypeError: cart.total is undefined (checkout.ts:42)']],
    ['surreal', 'Recall similar bugs', 'Graph lookup for past fixes',
      ['> SELECT ->fixed_by->fix FROM bug WHERE sig ~ "cart.total"', '~ 2 similar bugs found (#118, #131)']],
    ['daytona', 'Reproduce in sandbox', 'Isolated clone + Playwright replay',
      ['> daytona.create({ language: "typescript" })', '> npm ci && npx playwright test checkout.spec.ts', '! 1 failed, reproduced in 11.4s']],
    ['aws', 'Generate patch', 'Bedrock + repo context + memory',
      ['> bedrock.converse(model, ctx: stack + diff + similar fixes)', '+ patch: guard optional cart before reduce()']],
    ['daytona', 'Verify fix', 'Re-run the full suite in the sandbox',
      ['> npx playwright test', '+ 42 passed, 0 failed']],
    ['aws', 'Deploy', 'Canary 5% → 100%',
      ['> deploy canary 5% ... error rate 0.0%', '+ promoted to 100%, v1.4.3 live']],
    ['arize', 'Judge the fix', 'LLM-as-judge eval on the trace',
      ['> eval fix_quality: correctness 0.94, minimality 0.91', '+ trace exported, score 93/100']]
  ],
  why: [['Wow moment', 'A live site breaks on stage and heals itself.'], ['Sponsor depth', 'All five sponsors sit on the critical path.'], ['TS-native', 'Playwright, the SDKs and the app are all TypeScript.']],
  code: {
'agent.ts': `import Anchorbrowser from 'anchorbrowser';
import { Daytona } from '@daytonaio/sdk';
import { chromium } from 'playwright';
import { memory } from './memory';     // SurrealDB wrapper
import { tracer } from './telemetry';  // Arize via OpenTelemetry
import { proposeFix } from './bedrock';

export async function patrol(flow: Flow): Promise<void> {
  await tracer.startActiveSpan('patrol:' + flow.name, async (span) => {
    const session = await new Anchorbrowser().sessions.create();
    const browser = await chromium.connectOverCDP(session.data.cdp_url);
    const result = await flow.run(browser);            // click the key flow
    if (result.ok) return span.end();

    const similar = await memory.similarBugs(result.error);
    const sandbox = await new Daytona().create({ language: 'typescript' });
    await sandbox.git.clone(REPO_URL, 'app');
    const repro = await sandbox.process.executeCommand('npx playwright test ' + flow.spec, 'app');

    const patch = await proposeFix({ error: result.error, repro, similar });
    const green = await applyAndTest(sandbox, patch);
    if (green) await deployCanary(patch);
    await memory.recordFix(result.error, patch, green);
    span.end();
  });
}`,
'memory.ts': `import Surreal from 'surrealdb';

const db = new Surreal();
await db.connect(process.env.SURREAL_URL!, { namespace: 'qa', database: 'agent' });

export const memory = {
  similarBugs: (err: string) =>
    db.query('SELECT *, ->fixed_by->fix AS fixes FROM bug WHERE signature @@ $err LIMIT 3', { err }),

  recordFix: (err: string, patch: Patch, verified: boolean) =>
    db.query(
      'LET $b = (CREATE bug CONTENT { signature: $err, at: time::now() });' +
      'LET $f = (CREATE fix CONTENT { diff: $diff, verified: $verified });' +
      'RELATE $b->fixed_by->$f;',
      { err, diff: patch.diff, verified })
};`
  }
},
{
  title: 'Flag-to-Fix Widget', c: 'var(--warn)', score: 89,
  short: 'Add a "🐞 Bugs?" button to any site. A user flags an error, the agent captures the session, confirms it is a real bug and ships the fix.',
  desc: 'Built from the "User sees error, flags it" sketch and "User flag; fix had". A small TypeScript snippet turns your users into the QA team, and the agent does the engineering.',
  roles: {
    anchor: 'Replays what the user did from the captured events',
    daytona: 'Turns the replay into a failing regression test',
    aws: 'Bedrock triages, screens with Guardrails and writes the fix',
    surreal: 'Stores flag → session → bug and finds duplicates',
    arize: 'Scores triage accuracy and fix quality'
  },
  steps: [
    ['anchor', 'User flags bug', 'Widget captures DOM events + console',
      ['> widget.flag("button does nothing on mobile")', '> captured 23 events, 2 console errors, viewport 390x844']],
    ['aws', 'Triage', 'Bedrock Guardrails screens, model classifies',
      ['> guardrails.apply(note) -> clean', '~ class: bug, severity: high, area: nav']],
    ['surreal', 'Deduplicate', 'Is this a known issue?',
      ['> nearest flag similarity 0.41', '+ new issue #212 created']],
    ['anchor', 'Replay session', 'Anchor replays the user steps',
      ['> replay 23 events @ 390x844', '! click intercepted by .overlay']],
    ['daytona', 'Write failing test', 'Generate spec and confirm it fails',
      ['> create tests/flag-212.spec.ts', '! 1 failed (expected)']],
    ['aws', 'Fix + deploy', 'Patch, suite goes green, deploy',
      ['> patch: pointer-events on .overlay', '+ suite green, deployed, reporter notified "fixed ✓"']],
    ['arize', 'Evaluate', 'Judge triage + fix',
      ['> triage_correct=1, fix_quality=0.88', '+ score 89/100']]
  ],
  why: [['Easy to grasp', 'Click 🐞 and get a fix in about 60 seconds.'], ['Closes the loop', 'The user is told the bug they reported is fixed.'], ['Real product', 'Install with one script tag.']],
  code: {
'widget.ts': `// Usage: <script src="healops.js" data-project="lol"></script>
export function mountFlagButton(projectId: string): void {
  const events: CapturedEvent[] = [];
  for (const type of ['click', 'input', 'submit'] as const) {
    document.addEventListener(type, (e) => events.push(serialize(e)), true);
  }
  window.addEventListener('error', (e) => events.push({ type: 'error', msg: e.message }));

  const btn = createButton('🐞 Bugs?');
  btn.onclick = async () => {
    const note = await askUser('What went wrong?');
    await fetch('/api/flags', {
      method: 'POST',
      body: JSON.stringify({ projectId, note, url: location.href,
        events: events.slice(-50), viewport: [innerWidth, innerHeight] })
    });
  };
}`,
'triage.ts': `import { BedrockRuntimeClient, ApplyGuardrailCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });

export async function triage(flag: Flag) {
  const guard = await bedrock.send(new ApplyGuardrailCommand({
    guardrailIdentifier: GUARDRAIL_ID, guardrailVersion: '1', source: 'INPUT',
    content: [{ text: { text: flag.note } }]
  }));
  if (guard.action === 'GUARDRAIL_INTERVENED') return quarantine(flag);

  const dup = await memory.nearestFlag(flag);
  if (dup && dup.score > 0.85) return memory.linkDuplicate(flag, dup);
  return healLoop(flag); // Anchor replay -> Daytona test -> Bedrock fix
}`
  }
},
{
  title: 'Dependency Patch Bot', c: 'var(--bad)', score: 90,
  short: 'Automatic error and CVE search. The agent watches advisories for your dependencies, upgrades them in a sandbox, fixes any breaking changes and opens a tested PR.',
  desc: 'Built from "Anchor browser sees CVE" and "Automatic error/CVE search". The agent keeps dependencies patched without breaking the app.',
  roles: {
    anchor: 'Reads advisory pages and package changelogs',
    daytona: 'Runs the upgrade, the build and the tests in isolation',
    aws: 'Bedrock summarises changelogs and fixes breaking API changes',
    surreal: 'Graph of package → advisory → service → PR',
    arize: 'Tracks how often upgrades pass on the first try'
  },
  steps: [
    ['anchor', 'Watch advisories', 'Read advisory feed + changelog',
      ['> anchor visit advisory feed for npm ecosystem', '~ new advisory: "fast-xml" < 4.4.1 (high)']],
    ['surreal', 'Blast radius', 'Which services use it?',
      ['> SELECT <-depends_on<-service FROM package:fast_xml', '~ affects: api, checkout-worker']],
    ['daytona', 'Upgrade in sandbox', 'Bump + build + test',
      ['> npm install fast-xml@4.4.1', '! 3 type errors: parse() signature changed']],
    ['aws', 'Fix breaking change', 'Bedrock reads changelog, edits call sites',
      ['> bedrock: migrate parse(str, opts) -> new XMLParser(opts).parse(str)', '+ 3 call sites updated']],
    ['daytona', 'Verify', 'Full suite + npm audit',
      ['> npm test && npm audit --omit=dev', '+ 118 passed, 0 high or critical findings']],
    ['aws', 'Open PR + deploy', 'PR with summary, auto-merge on green',
      ['+ PR #87 opened: "patch fast-xml advisory"', '+ deployed to staging']],
    ['arize', 'Score', 'Eval upgrade quality',
      ['> first_try_pass=0, final_pass=1, diff_size=small', '+ score 90/100']]
  ],
  why: [['Security story', 'Patched before anyone files a ticket.'], ['Clear value', 'Every team has outdated dependencies.'], ['Graph shines', 'SurrealDB shows the blast radius at a glance.']],
  code: {
'patch-bot.ts': `import { Daytona } from '@daytonaio/sdk';

export async function patchDependency(advisory: Advisory) {
  const services = await db.query(
    'SELECT <-depends_on<-service AS svc FROM type::thing("package", $name)',
    { name: advisory.pkg });

  const sandbox = await new Daytona().create({ language: 'typescript' });
  await sandbox.git.clone(REPO_URL, 'app');
  await sandbox.process.executeCommand('npm install ' + advisory.pkg + '@' + advisory.fixedIn, 'app');

  let build = await sandbox.process.executeCommand('npx tsc --noEmit', 'app');
  for (let attempt = 0; build.exitCode !== 0 && attempt < 3; attempt++) {
    const edits = await askBedrock({ errors: build.result, changelog: advisory.changelog });
    await applyEdits(sandbox, edits);
    build = await sandbox.process.executeCommand('npx tsc --noEmit', 'app');
  }
  const tests = await sandbox.process.executeCommand('npm test', 'app');
  if (tests.exitCode === 0) await openPullRequest(sandbox, advisory, services);
}`
  }
},
{
  title: 'Injection Shield', c: 'var(--arize)', score: 91,
  short: 'Keeps the agent safe. Every user flag and every page the agent reads is screened, so hidden instructions cannot steer the fixer or leak data.',
  desc: 'Built from "flag prompt injection that would give info/auth" and "Avoid attempted user prompt injection". If an agent can deploy code, it needs a guard in front of it.',
  roles: {
    anchor: 'Captures the page text the agent is about to read',
    daytona: 'Agent tools run in a locked-down sandbox with no secrets',
    aws: 'Bedrock Guardrails + a classifier screen all untrusted input',
    surreal: 'Records blocked attempts as a graph (source → pattern → target)',
    arize: 'Red-team evals measure how much gets blocked'
  },
  steps: [
    ['anchor', 'Ingest untrusted text', 'Flag note + page content',
      ['> received flag #233 with 1.2kb of free text']],
    ['aws', 'Screen input', 'Guardrails + classifier',
      ['> guardrails.apply(note)', '! intervened: asks the agent to reveal credentials']],
    ['surreal', 'Log the attempt', 'Link to source + earlier attempts',
      ['> RELATE ip:203_0_113_7->attempted->pattern:credential_request', '~ 3rd attempt from this source this week']],
    ['daytona', 'Least-privilege tools', 'Sandbox has no prod secrets',
      ['> sandbox env: no AWS keys, read-only repo token', '+ nothing to leak even if screening misses']],
    ['aws', 'Continue safely', 'Process the clean part only',
      ['+ flag quarantined, maintainer notified', '+ healing loop continues for other flags']],
    ['arize', 'Red-team eval', 'Nightly adversarial suite',
      ['> eval suite: 200 adversarial cases', '+ blocked 197/200, score 91/100']]
  ],
  why: [['Responsible AI', 'Shows judges you thought about risk.'], ['Defense in depth', 'Screening, least privilege and monitoring.'], ['Measurable', 'Arize turns safety into a number.']],
  code: {
'shield.ts': `type Verdict = { safe: boolean; reason?: string };

export async function screen(untrusted: string, source: string): Promise<Verdict> {
  const guard = await bedrock.send(new ApplyGuardrailCommand({
    guardrailIdentifier: GUARDRAIL_ID, guardrailVersion: '1', source: 'INPUT',
    content: [{ text: { text: untrusted } }]
  }));
  const verdict: Verdict = guard.action === 'GUARDRAIL_INTERVENED'
    ? { safe: false, reason: 'guardrail' }
    : await classifyIntent(untrusted); // second opinion from a small model

  if (!verdict.safe) {
    await db.query('RELATE type::thing("source", $s)->attempted->type::thing("pattern", $r)',
      { s: source, r: verdict.reason });
  }
  span.setAttribute('shield.safe', verdict.safe); // Arize trace attribute
  return verdict;
}

// Untrusted text always goes in as data, never as system instructions.
export const wrapUntrusted = (t: string) => '<untrusted>' + escapeTags(t) + '</untrusted>';`
  }
},
{
  title: 'Safe Deploy & Migration Guard', c: 'var(--aws)', score: 88,
  short: 'Avoid the Cloudflare incident. Every fix, config change and DB migration is rehearsed in a sandbox, rolled out as a canary and rolled back automatically.',
  desc: 'Built from "Automatic database migration", "Debugging and deploying", "Use of AWS to check redundancy" and "Avoid Cloudflare incident". A bad config or migration should never reach every user at once.',
  roles: {
    anchor: 'Runs key flows against the canary before promotion',
    daytona: 'Rehearses the migration on a snapshot copy of the DB',
    aws: 'Multi-AZ canary rollout and health checks; Bedrock writes the down-migration',
    surreal: 'Stores the schema-version graph and rollback plans',
    arize: 'Watches the canary for drift and gates promotion'
  },
  steps: [
    ['aws', 'Change proposed', 'Agent fix includes a schema change',
      ['> migration 0042_add_cart_currency.ts', '> bedrock: generated matching down-migration']],
    ['daytona', 'Rehearse on snapshot', 'Run up → down → up',
      ['> restore snapshot (2.1M rows)', '+ up 4.2s, down 3.9s, up 4.1s, data checksums match']],
    ['surreal', 'Record version graph', 'schema v41 → v42 + rollback path',
      ['+ RELATE schema:v41->migrates_to->schema:v42']],
    ['aws', 'Canary 5% (multi-AZ)', 'Health checks in 2 zones',
      ['> canary us-east-1a/1b at 5%', '~ p95 latency +38% in 1b']],
    ['anchor', 'Flow check on canary', 'Click key flows on canary',
      ['! checkout flow timeout on canary']],
    ['aws', 'Auto-rollback', 'Revert before wide impact',
      ['+ rolled back to v41 in 22s, 0.4% of traffic affected', '> agent reopens the bug with new evidence']],
    ['arize', 'Gate decision', 'Score the rollout decision',
      ['+ correct rollback, score 88/100']]
  ],
  why: [['Real-world hook', 'Named after a famous outage judges will know.'], ['AWS depth', 'Uses multi-AZ, canaries and health checks.'], ['Trust', 'The agent is allowed to ship because it can undo.']],
  code: {
'rollout.ts': `export async function guardedRollout(change: Change) {
  if (change.migration) {
    const sb = await new Daytona().create({ language: 'typescript' });
    await restoreSnapshot(sb, 'prod-latest');
    for (const dir of ['up', 'down', 'up'] as const) {
      const r = await sb.process.executeCommand('npx tsx migrate.ts ' + dir, 'app');
      if (r.exitCode !== 0) return reject(change, 'migration rehearsal failed');
    }
  }

  for (const pct of [5, 25, 100]) {
    await setTrafficWeight(change.version, pct);       // AWS canary
    await sleep(60_000);
    const health = await checkHealth(change.version);  // CloudWatch, per AZ
    const flows = await runKeyFlows(canaryUrl(change)); // Anchor
    const drift = await arizeDrift(change.version);
    if (!health.ok || !flows.ok || drift > 0.2) return rollback(change);
  }
  await db.query('RELATE $from->migrates_to->$to', { from: change.prev, to: change.version });
}`
  }
},
{
  title: 'Bug Memory Graph + Judge', c: 'var(--surreal)', score: 95,
  short: 'A live mission-control dashboard. Every bug, fix and file in a SurrealDB graph, with Arize traces showing why the agent chose each fix and how good it was.',
  desc: 'Built from "Telemetry: store agent context in SurrealDB, judge agent with Arize". This is the screen you demo on: the agent's memory and report card, live.',
  roles: {
    anchor: 'Sends every flow run and screenshot to the timeline',
    daytona: 'Each sandbox run is linked as evidence on its node',
    aws: 'Bedrock judge model; dashboard hosted on AWS',
    surreal: 'Live graph queries feed the dashboard in real time',
    arize: 'Trace explorer, eval scores and quality trends'
  },
  steps: [
    ['surreal', 'Live query', 'Subscribe to graph changes',
      ['> LIVE SELECT * FROM bug, fix, fixed_by', '+ streaming 312 nodes, 488 edges']],
    ['anchor', 'Ingest flow runs', 'Screenshots + step timings',
      ['> 1,204 flow runs today, 3 failures']],
    ['daytona', 'Attach evidence', 'Repro logs on each bug node',
      ['+ bug:212 <- evidence: sandbox run sb_9f2 (red), sb_a10 (green)']],
    ['arize', 'Pull traces', 'Reasoning per fix',
      ['> span tree: recall -> repro -> patch -> verify -> deploy']],
    ['aws', 'Judge', 'Bedrock grades each fix',
      ['> rubric: correctness, minimality, test coverage, safety', '+ weekly mean 4.6 / 5']],
    ['surreal', 'Spot hotspots', 'Files with repeat bugs',
      ['~ checkout.ts touched by 7 fixes, suggest refactor']]
  ],
  why: [['Demo canvas', 'An animated graph looks great on a projector.'], ['Explainable', 'Judges see why the agent made each choice.'], ['Learning loop', 'Memory makes the next fix faster.']],
  code: {
'dashboard.ts': `import Surreal from 'surrealdb';

const db = new Surreal();
await db.connect(SURREAL_WS_URL, { namespace: 'qa', database: 'agent' });

// Push graph changes to the UI as they happen
const liveId = await db.live('fixed_by', (action, edge) => {
  graph.upsertEdge(edge.in, edge.out, { verified: edge.verified });
  if (action === 'CREATE') graph.pulse(edge.out);
});

// Hotspots: files touched by the most fixes
const [hot] = await db.query(
  'SELECT out AS file, count() AS fixes FROM touches GROUP BY file ORDER BY fixes DESC LIMIT 5');
renderHotspots(hot);

// Link each node to its Arize trace for one-click "why?"
graph.onClick((node) => window.open(ARIZE_TRACE_URL + node.traceId));`
  }
}
];
