#!/usr/bin/env node
// Build/refresh <repo>/.env from a loosely formatted keys file (default: ../apis.txt).
// Understands `set KEY=VALUE` / `export KEY=VALUE` / `KEY=VALUE` lines, plus
// "sponsor:" headings followed by bare keys/URLs. Never prints secret values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(process.argv[2] ?? path.join(root, '..', 'apis.txt'));
const envFile = path.join(root, '.env');

if (!fs.existsSync(src)) {
  console.error(`keys file not found: ${src}`);
  process.exit(1);
}

const found = new Map();
const put = (key, value) => {
  if (value) found.set(key, value.trim());
};

const SECTIONS = [
  [/^anchor/i, 'anchor'],
  [/^dayton/i, 'daytona'],
  [/^surreal/i, 'surreal'],
  [/^arize/i, 'arize'],
  [/^(aws|bedrock|amazon)/i, 'aws'],
  [/^(anthropic|claude)/i, 'anthropic'],
];

let section = '';
for (const raw of fs.readFileSync(src, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;

  const kv = line.match(/^(?:set|export)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/i);
  if (kv && /^[A-Z0-9_]+$/.test(kv[1])) {
    put(kv[1], kv[2].replace(/^["']|["']$/g, ''));
    continue;
  }

  const heading = SECTIONS.find(([re]) => re.test(line));
  if (heading && line.replace(/[:\s]+$/, '').split(/\s+/).length <= 3 && !/[_-]{1}[A-Za-z0-9]{12,}/.test(line)) {
    section = heading[1];
    continue;
  }

  // a "Label: value" line (but never split a URL on its scheme colon)
  const lineIsUrl = /^(https?|wss?):\/\//i.test(line);
  const labelled = lineIsUrl ? null : line.match(/^([A-Za-z ][A-Za-z ]{1,30}):\s*(\S+)$/);
  const value = labelled ? labelled[2] : line;
  if (labelled) {
    const h = SECTIONS.find(([re]) => re.test(labelled[1]));
    if (h) section = h[1];
  }
  // section fallbacks never overwrite a key that was already identified
  const putNew = (key, v) => (found.has(key) ? console.warn(`  ? extra value for ${key} ignored`) : put(key, v));

  const isUrl = /^(https?|wss?):\/\//i.test(value);
  if (/^sk-ant-/.test(value)) put('ANTHROPIC_API_KEY', value);
  else if (/^dtn_/.test(value)) put('DAYTONA_API_KEY', value);
  else if (/^ak-/.test(value)) put('ARIZE_API_KEY', value);
  // sdbp_… = Surreal Cloud personal access token (control plane), not a database credential
  else if (/^sdbp_/i.test(value)) put('SURREAL_CLOUD_TOKEN', value);
  else if (/^sdb/i.test(value)) put('SURREAL_TOKEN', value);
  else if (isUrl && section === 'daytona') put('DAYTONA_API_URL', value);
  else if (isUrl && section === 'surreal') put('SURREAL_URL', value);
  else if (isUrl && section === 'arize') put('ARIZE_OTLP_ENDPOINT', value);
  else if (isUrl) console.warn(`  ? skipped a URL in section "${section || 'none'}"`);
  else if (section === 'anchor') putNew('ANCHOR_API_KEY', value);
  else if (section === 'daytona') putNew('DAYTONA_API_KEY', value);
  else if (section === 'surreal') putNew(found.has('SURREAL_TOKEN') ? 'SURREAL_URL' : 'SURREAL_TOKEN', value);
  else if (section === 'arize') putNew(found.has('ARIZE_API_KEY') ? 'ARIZE_SPACE_ID' : 'ARIZE_API_KEY', value);
  else if (section === 'anthropic') putNew('ANTHROPIC_API_KEY', value);
  else console.warn(`  ? skipped an unrecognised line (${value.length} chars) in section "${section || 'none'}"`);
}

if (found.has('AWS_DEFAULT_REGION') && !found.has('AWS_REGION')) found.set('AWS_REGION', found.get('AWS_DEFAULT_REGION'));
// a Surreal Cloud PAT that an older import stored as SURREAL_TOKEN must not be used as a DB token
const dropKeys = new Set(found.has('SURREAL_CLOUD_TOKEN') && !found.has('SURREAL_TOKEN') ? ['SURREAL_TOKEN'] : []);

// Merge into .env (start from .env.example if there is no .env yet), preserving other lines.
const base = fs.existsSync(envFile)
  ? fs.readFileSync(envFile, 'utf8')
  : fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const lines = base.split(/\r?\n/);
const seen = new Set();
const out = lines.map((l) => {
  const m = l.match(/^([A-Z0-9_]+)=/);
  if (m && dropKeys.has(m[1])) return `${m[1]}=`;
  if (m && found.has(m[1])) {
    seen.add(m[1]);
    return `${m[1]}=${found.get(m[1])}`;
  }
  return l;
});
const extra = [...found.keys()].filter((k) => !seen.has(k));
if (extra.length) out.push('', '# imported from keys file', ...extra.map((k) => `${k}=${found.get(k)}`));
fs.writeFileSync(envFile, out.join('\n'));

console.log(`wrote ${path.relative(process.cwd(), envFile) || envFile} from ${src}`);
for (const [k, v] of [...found].sort()) console.log(`  ✓ ${k.padEnd(24)} (${v.length} chars)`);
