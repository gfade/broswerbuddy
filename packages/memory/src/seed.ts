/**
 * Realistic past history for the demo: three healed bugs with verified, deployed fixes, and two
 * healed incidents that reference them. Only written into an empty memory, so repeated calls are no-ops.
 */
import { unifiedDiff, type Memory } from '@healops/shared';

const DAY_MS = 86_400_000;

/** A plain unified diff: the shared helper prefixes a "====" banner, which is dropped here. */
function patchFor(file: string, before: string, after: string): string {
  return unifiedDiff(file, before, after).replace(/^[\s\S]*?(?=^--- )/m, '');
}

const CART_BEFORE = `export function renderTotals(state) {
  const subtotal = state.cart.totals.total;
  el.totalLabel.textContent = formatMoney(subtotal);
  el.itemCount.textContent = String(state.cart.items.length);
}
`;

const CART_AFTER = `export function renderTotals(state) {
  const totals = state.cart?.totals ?? { total: 0 };
  el.totalLabel.textContent = formatMoney(totals.total);
  el.itemCount.textContent = String(state.cart?.items?.length ?? 0);
}
`;

const SIGNUP_BEFORE = `const EMAIL_RE = /^[A-Za-z0-9_-]+@[A-Za-z0-9-]+\\.[A-Za-z]{2,}$/;

export function validateEmail(value) {
  return EMAIL_RE.test(value.trim());
}
`;

const SIGNUP_AFTER = `const EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;

export function validateEmail(value) {
  return EMAIL_RE.test(value.trim());
}
`;

const BANNER_BEFORE = `.promo-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 50;
  background: #1f2937;
  color: #fff;
  padding: 8px 16px;
  text-align: center;
}
`;

const BANNER_AFTER = `.promo-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 50;
  pointer-events: none;
  background: #1f2937;
  color: #fff;
  padding: 8px 16px;
  text-align: center;
}

.promo-banner a {
  pointer-events: auto;
}
`;

/**
 * Inserts the demo history into `memory` and returns the number of past bugs written (3).
 * Returns 0 without writing anything if the memory already holds bugs.
 * `embed` produces the signature embedding, so the same model as live traffic is used.
 */
export async function seedHistory(memory: Memory, embed: (text: string) => Promise<number[]>): Promise<number> {
  if ((await memory.stats()).bugs > 0) return 0;
  const now = Date.now();

  const cartSignature = "TypeError: Cannot read properties of undefined (reading 'total') @ js/cart.js";
  const cartBug = await memory.recordBug({
    incidentId: 'inc_seed_checkout',
    signature: cartSignature,
    flowId: 'checkout',
    errorMessage: "Cannot read properties of undefined (reading 'total')",
    stack:
      "TypeError: Cannot read properties of undefined (reading 'total')\n" +
      '    at renderTotals (js/cart.js:2:33)\n' +
      '    at onCartChange (js/cart.js:31:5)',
    severity: 'sev2',
    embedding: await embed(cartSignature),
  });
  const cartFix = await memory.recordFix({
    bugId: cartBug.id,
    incidentId: 'inc_seed_checkout',
    summary: 'Guard cart totals before reading them',
    rootCause:
      'renderTotals() read state.cart.totals.total before the cart had hydrated from storage. ' +
      'For a returning shopper the first render ran with totals undefined and threw.',
    diff: patchFor('js/cart.js', CART_BEFORE, CART_AFTER),
    files: ['js/cart.js'],
    verified: true,
    deployed: true,
    score: 92,
  });

  const signupSignature = 'Email validation rejects valid addresses with dots @ js/signup.js';
  const signupBug = await memory.recordBug({
    incidentId: 'inc_seed_regression',
    signature: signupSignature,
    flowId: 'signup',
    errorMessage: 'Signup rejected a valid address: first.last@example.com',
    severity: 'sev3',
    embedding: await embed(signupSignature),
  });
  await memory.recordFix({
    bugId: signupBug.id,
    incidentId: 'inc_seed_regression',
    summary: 'Relax email regex',
    rootCause:
      'EMAIL_RE allowed only letters, digits, underscore and hyphen in the local part, ' +
      'so any address containing a dot was rejected as invalid.',
    diff: patchFor('js/signup.js', SIGNUP_BEFORE, SIGNUP_AFTER),
    files: ['js/signup.js'],
    verified: true,
    deployed: true,
    score: 88,
  });

  const bannerSignature = 'Click intercepted by promo banner overlay @ css/store.css';
  const bannerBug = await memory.recordBug({
    incidentId: 'inc_seed_regression',
    signature: bannerSignature,
    flowId: 'add-to-cart',
    errorMessage:
      'Element <button class="add-to-cart"> is not clickable at point (640, 112). ' +
      'Other element would receive the click: <div class="promo-banner">',
    severity: 'sev2',
    embedding: await embed(bannerSignature),
  });
  const bannerFix = await memory.recordFix({
    bugId: bannerBug.id,
    incidentId: 'inc_seed_regression',
    summary: 'Make promo banner ignore pointer events',
    rootCause:
      '.promo-banner is fixed across the top of the page and sits over the add-to-cart buttons ' +
      'on narrow viewports, so it swallows their clicks.',
    diff: patchFor('css/store.css', BANNER_BEFORE, BANNER_AFTER),
    files: ['css/store.css'],
    verified: true,
    deployed: true,
    score: 90,
  });

  await memory.upsertIncident({
    id: 'inc_seed_checkout',
    title: "Checkout 500: cannot read 'total' of undefined",
    status: 'healed',
    source: 'patrol',
    flowId: 'checkout',
    severity: 'sev2',
    openedAt: now - 6 * DAY_MS,
    closedAt: now - 6 * DAY_MS + 212_000,
    outcome: 'healed',
    score: 93,
    bugId: cartBug.id,
    fixId: cartFix.id,
    healMs: 212_000,
  });
  await memory.upsertIncident({
    id: 'inc_seed_regression',
    title: 'Post-deploy regression: add-to-cart blocked',
    status: 'healed',
    source: 'patrol',
    flowId: 'add-to-cart',
    severity: 'sev2',
    openedAt: now - 2 * DAY_MS,
    closedAt: now - 2 * DAY_MS + 41_000,
    outcome: 'healed',
    score: 88,
    // Recall matched the promo-banner bug from earlier history and reused its fix.
    memoryHit: bannerBug.id,
    bugId: bannerBug.id,
    fixId: bannerFix.id,
    healMs: 41_000,
  });

  return 3;
}
