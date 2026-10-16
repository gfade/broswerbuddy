// Scripted demo data for the fake runtime: flows, seeded bugs, the two healing scenarios and past history.
import type { EvalRubric, Severity } from '@healops/shared';

export interface FakeFlow {
  id: string;
  name: string;
  description: string;
  /** Page the flow starts on; used to map a user's bug report to a flow. */
  path: string;
  critical: boolean;
  steps: string[];
}

export const FAKE_FLOWS: FakeFlow[] = [
  {
    id: 'checkout',
    name: 'Checkout',
    description: 'Add an item, open the cart, go to checkout and place the order.',
    path: '/checkout',
    critical: true,
    steps: ['open storefront', 'add Linen Shirt to cart', 'open cart', 'go to checkout', 'place order'],
  },
  {
    id: 'add-to-cart',
    name: 'Add to cart',
    description: 'Open a product page, add it to the cart and check the header badge.',
    path: '/products',
    critical: false,
    steps: ['open storefront', 'open product page', 'add to cart', 'badge shows 1', 'open cart'],
  },
  {
    id: 'signup',
    name: 'Sign up',
    description: 'Create an account with an email address and a password.',
    path: '/signup',
    critical: true,
    steps: ['open signup', 'fill email and password', 'submit form', 'confirmation email sent', 'land on dashboard'],
  },
];

export interface FakeSeed {
  id: string;
  title: string;
  flowId: string;
  description: string;
}

/** Bugs the demo store can be seeded with ("break it again"). cart-subtotal is live at boot. */
export const FAKE_SEEDS: FakeSeed[] = [
  {
    id: 'cart-subtotal',
    title: 'Cart total crashes at checkout',
    flowId: 'checkout',
    description: 'v1.4.2 restores carts without a summary, so placing an order after a reload throws in computeTotals().',
  },
  {
    id: 'signup-validation',
    title: 'Signup rejects valid emails',
    flowId: 'signup',
    description: 'The email input is looked up by a stale id after the form re-renders, so validation throws on submit.',
  },
];

export interface FakeScenario {
  seedId: string;
  flowId: string;
  title: string;
  severity: Severity;
  category: string;
  failedStep: number;
  errorMessage: string;
  errorStack: string;
  signature: string;
  triageSummary: string;
  memoryMatches: { bugId: string; similarity: number; signature: string; fixSummary: string; score: number }[];
  bugId: string;
  fixSummary: string;
  rootCause: string;
  reasoning: string[];
  confidence: number;
  file: string;
  before: string;
  after: string;
  thinking: string[];
  textChunks: string[];
  /** Risk when the fix is auto-applied; approval-gated fixes use at least 58. */
  risk: number;
  reasons: string[];
  preScore: number;
  reproLog: string[];
  reproSummary: string;
  verifyLog: string[];
  verifySummary: string;
  score: number;
  rubric: EvalRubric;
  verdict: string;
  summary: string;
  deployNote: string;
}

const CART_BEFORE = `// js/cart.js: cart state kept in localStorage and mirrored in the header badge.
const CART_KEY = 'shop.cart.v2';

export function createCart() {
  return { items: [], summary: undefined };
}

export function addItem(cart, product, qty = 1) {
  const existing = cart.items.find((i) => i.sku === product.sku);
  if (existing) existing.qty += qty;
  else cart.items.push({ sku: product.sku, name: product.name, price: product.price, qty });
  cart.summary = computeSummary(cart.items);
  return cart;
}

export function restoreCart(storage = window.localStorage) {
  const raw = storage.getItem(CART_KEY);
  if (!raw) return createCart();
  try {
    const parsed = JSON.parse(raw);
    return { items: parsed.items ?? [], summary: undefined };
  } catch {
    return createCart();
  }
}

export function computeSummary(items) {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const tax = Math.round(subtotal * 0.0825);
  return { subtotal, tax, total: subtotal + tax };
}

export function computeTotals(cart) {
  return {
    subtotal: cart.summary.subtotal,
    tax: cart.summary.tax,
    total: cart.summary.total,
  };
}
`;

const CART_AFTER = `// js/cart.js: cart state kept in localStorage and mirrored in the header badge.
const CART_KEY = 'shop.cart.v2';

export function createCart() {
  return { items: [], summary: undefined };
}

export function addItem(cart, product, qty = 1) {
  const existing = cart.items.find((i) => i.sku === product.sku);
  if (existing) existing.qty += qty;
  else cart.items.push({ sku: product.sku, name: product.name, price: product.price, qty });
  cart.summary = computeSummary(cart.items);
  return cart;
}

export function restoreCart(storage = window.localStorage) {
  const raw = storage.getItem(CART_KEY);
  if (!raw) return createCart();
  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return { items, summary: computeSummary(items) };
  } catch {
    return createCart();
  }
}

export function computeSummary(items) {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const tax = Math.round(subtotal * 0.0825);
  return { subtotal, tax, total: subtotal + tax };
}

export function computeTotals(cart) {
  const summary = cart.summary ?? computeSummary(cart.items);
  return {
    subtotal: summary.subtotal,
    tax: summary.tax,
    total: summary.total,
  };
}
`;

const SIGNUP_BEFORE = `// js/signup.js: client-side validation before POST /api/signup.
export function validateForm(form) {
  const email = document.getElementById('email');
  const password = form.password.value;
  if (!email.value.includes('@')) return 'Enter a valid email address.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  return null;
}
`;

const SIGNUP_AFTER = `// js/signup.js: client-side validation before POST /api/signup.
export function validateForm(form) {
  const email = form.querySelector('[name="email"]');
  const password = form.password.value;
  if (!email?.value.includes('@')) return 'Enter a valid email address.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  return null;
}
`;

const CHECKOUT_LOG_REPRO = [
  '$ git -C /work/site log --oneline -1',
  '3f9a2c1 release: v1.4.2 cart restore refactor',
  '$ npm ci --no-audit --no-fund',
  'added 37 packages in 3s',
  '$ node --test tests/',
  '# Subtest: catalog renders',
  'ok 1 - catalog renders 6 products',
  '# Subtest: add to cart updates the badge',
  'ok 2 - add to cart updates the badge',
  '# Subtest: checkout totals after cart restore',
  'not ok 3 - checkout totals after cart restore',
  `  error: "Cannot read properties of undefined (reading 'subtotal')"`,
  '  at computeTotals (js/cart.js:35:28)',
  '  at renderTotals (js/checkout.js:18:12)',
  '1..3',
  '# tests 3',
  '# pass 2',
  '# fail 1',
  '$ npx playwright test checkout.spec.ts --reporter=line',
  'Running 1 test using 1 worker',
  'x  1) checkout > place order (2.1s)',
  `  1 failed: TypeError: Cannot read properties of undefined (reading 'subtotal')`,
];

const CHECKOUT_LOG_VERIFY = [
  '$ git apply patches/0001-cart-summary.patch',
  'patching file js/cart.js',
  '$ node --test tests/',
  'ok 1 - catalog renders 6 products',
  'ok 2 - add to cart updates the badge',
  'ok 3 - checkout totals after cart restore',
  'ok 4 - regression: restore without summary (tests/regression-cart-restore.test.mjs)',
  '# tests 4',
  '# pass 4',
  '# fail 0',
  '$ npx playwright test checkout.spec.ts --reporter=line',
  'Running 1 test using 1 worker',
  'ok  1) checkout > place order (1.8s)',
  '  1 passed (1.8s)',
];

const SIGNUP_LOG_REPRO = [
  '$ node --test tests/',
  'ok 1 - signup page renders',
  'not ok 2 - signup accepts a valid email',
  `  error: "Cannot read properties of null (reading 'value')"`,
  '  at validateForm (js/signup.js:5:14)',
  '1..2',
  '# pass 1',
  '# fail 1',
];

const SIGNUP_LOG_VERIFY = [
  '$ git apply patches/0002-signup-email-lookup.patch',
  'patching file js/signup.js',
  '$ node --test tests/',
  'ok 1 - signup page renders',
  'ok 2 - signup accepts a valid email',
  '# pass 2',
  '# fail 0',
];

export const SCENARIOS: FakeScenario[] = [
  {
    seedId: 'cart-subtotal',
    flowId: 'checkout',
    title: 'Checkout fails: cart total crashes on place order',
    severity: 'sev2',
    category: 'checkout-crash',
    failedStep: 4,
    errorMessage: "TypeError: Cannot read properties of undefined (reading 'subtotal')",
    errorStack: `TypeError: Cannot read properties of undefined (reading 'subtotal')
    at computeTotals (js/cart.js:35:28)
    at renderTotals (js/checkout.js:18:12)
    at HTMLButtonElement.<anonymous> (js/checkout.js:61:5)`,
    signature: "TypeError: Cannot read properties of undefined (reading 'subtotal') @ js/cart.js",
    triageSummary:
      'Every checkout that starts from a restored cart (page reload or new tab) fails on Place order with a TypeError in js/cart.js. Customers cannot pay.',
    memoryMatches: [
      {
        bugId: 'bug_cart_0412',
        similarity: 0.87,
        signature: "TypeError: Cannot read properties of undefined (reading 'subtotal') @ js/cart.js",
        fixSummary: 'Recompute cart summary when restoring from storage',
        score: 92,
      },
      {
        bugId: 'bug_cart_0309',
        similarity: 0.41,
        signature: "TypeError: Cannot read properties of null (reading 'textContent') @ js/cart.js",
        fixSummary: 'Guard the badge update when the header is missing',
        score: 88,
      },
    ],
    bugId: 'bug_9f2c41',
    fixSummary: 'Derive the cart summary when a cart is restored from storage',
    rootCause:
      'v1.4.2 changed restoreCart() to return summary: undefined. addItem() still sets the summary, so the crash only happens for carts restored from localStorage, for example after a reload on /checkout. computeTotals() reads cart.summary.subtotal without a guard.',
    reasoning: [
      'The stack points at computeTotals() in js/cart.js, and the same signature matched bug_cart_0412 at 0.87.',
      'restoreCart() returns summary: undefined in 1.4.2; addItem() is the only other writer, so restored carts are unguarded.',
      'Minimal fix: derive the summary from the items when it is missing. One function, one file, no behaviour change for fresh carts.',
      'Regression test restores a cart with no summary and asserts that an empty cart has a zero subtotal.',
    ],
    confidence: 0.91,
    file: 'js/cart.js',
    before: CART_BEFORE,
    after: CART_AFTER,
    thinking: [
      "The failure is on Place order: TypeError: Cannot read properties of undefined (reading 'subtotal') at computeTotals in js/cart.js.",
      "The sandbox reproduces it on the first run. Catalog and add-to-cart pass and only the checkout totals test fails, so this is a real regression rather than a flaky selector.",
      'Recall returned a close match: bug_cart_0412 has the same signature in js/cart.js at similarity 0.87, and its fix recomputed the summary when a cart is restored.',
      'Reading the 1.4.2 diff, restoreCart() now returns summary: undefined. addItem() still sets the summary, so the crash only happens for carts restored from localStorage.',
      'computeTotals() reads cart.summary.subtotal with no guard, which is why a shopper who reloads mid-checkout always hits it.',
      'Minimal fix: derive the summary from the items when it is missing, and keep the eager computation in addItem() unchanged. One function plus restoreCart(), one file.',
      'Regression guard: a node:test that restores a cart with no summary and asserts an empty cart has a zero subtotal, so this cannot come back silently.',
      'Edge cases checked: empty storage, malformed JSON (falls back to an empty cart) and items priced at zero. Each produces a valid summary after the patch.',
      'Confidence is high, about 0.91. The stack trace points at one line, the memory match agrees, and the sandbox can verify the whole flow end to end.',
    ],
    textChunks: [
      'Fix: derive the cart summary in restoreCart() and fall back to computeSummary() in computeTotals(). ',
      'Adding tests/regression-cart-restore.test.mjs to pin the restore path.',
    ],
    risk: 31,
    reasons: [
      '1 file changed (js/cart.js); no auth, payment or schema code touched',
      'regression test added',
      'sandbox verify passed',
      'similar past fix succeeded (similarity 0.87)',
    ],
    preScore: 84,
    reproLog: CHECKOUT_LOG_REPRO,
    reproSummary: '1 of 3 tests failed: checkout totals after cart restore (TypeError at js/cart.js:35)',
    verifyLog: CHECKOUT_LOG_VERIFY,
    verifySummary: '4 of 4 unit tests and the checkout end-to-end flow passed',
    score: 93,
    rubric: { correctness: 0.95, minimality: 0.92, testCoverage: 0.9, safety: 0.97, memoryUse: 0.88 },
    verdict:
      'Minimal, targeted fix at the root cause. Regression test added. Reused the 0.87 memory match without copying its unrelated changes.',
    summary: 'Restored carts now get a computed summary; checkout passes end to end on the new version.',
    deployNote: 'healed: checkout cart restore',
  },
  {
    seedId: 'signup-validation',
    flowId: 'signup',
    title: 'Signup fails: valid emails rejected with a TypeError',
    severity: 'sev2',
    category: 'auth-form',
    failedStep: 2,
    errorMessage: "TypeError: Cannot read properties of null (reading 'value')",
    errorStack: `TypeError: Cannot read properties of null (reading 'value')
    at validateForm (js/signup.js:5:14)
    at submit (js/main.js:12:5)`,
    signature: "TypeError: Cannot read properties of null (reading 'value') @ js/signup.js",
    triageSummary:
      'New accounts cannot be created: submitting the signup form throws inside validateForm(). This is an auth-adjacent path, so a reviewer must approve the fix.',
    memoryMatches: [
      {
        bugId: 'bug_signup_0227',
        similarity: 0.64,
        signature: "TypeError: Cannot read properties of null (reading 'value') @ js/signup.js",
        fixSummary: 'Look up the email input by name instead of a stale id',
        score: 90,
      },
    ],
    bugId: 'bug_5d0a17',
    fixSummary: 'Look up the email input by name, not by a stale id',
    rootCause:
      'The email input is re-rendered with a new id, so getElementById() returns null and validateForm() reads .value of null.',
    reasoning: [
      'The error is a null read of .value in validateForm(), so the email input is not in the DOM when the handler runs.',
      'The form is re-rendered after load and the input gets a new id, so the lookup by id returns null.',
      'Fix: query the input by name inside the form and treat a missing field as invalid.',
    ],
    confidence: 0.86,
    file: 'js/signup.js',
    before: SIGNUP_BEFORE,
    after: SIGNUP_AFTER,
    thinking: [
      'The error is a null read of .value in validateForm() in js/signup.js, so the email input is missing from the DOM when the submit handler runs.',
      'The form is re-rendered after load and the input gets a new id, so getElementById(email) returns null on submit.',
      'Recall: bug_signup_0227 belongs to the same family, but similarity is only 0.64, below the 0.85 cutoff, so it is context rather than a shortcut.',
      'Fix: query the input by name inside the form and treat a missing field as invalid. This touches the account creation path, so the gate will require a human to approve it.',
    ],
    textChunks: ['Fix: look up the email field by name inside the form and treat a missing field as invalid. '],
    risk: 64,
    reasons: ['touches the account creation path', 'user-facing auth form', 'risk is above the auto-merge threshold of 50'],
    preScore: 79,
    reproLog: SIGNUP_LOG_REPRO,
    reproSummary: '1 of 2 tests failed: signup accepts a valid email (TypeError at js/signup.js:5)',
    verifyLog: SIGNUP_LOG_VERIFY,
    verifySummary: '2 of 2 unit tests passed',
    score: 90,
    rubric: { correctness: 0.93, minimality: 0.9, testCoverage: 0.84, safety: 0.9, memoryUse: 0.6 },
    verdict:
      'Correct, narrow fix to a null lookup. Tests cover the valid-email path; a negative-case test would strengthen it.',
    summary: 'Signup accepts valid emails again; the fix was approved by a reviewer before deploy.',
    deployNote: 'healed: signup email lookup',
  },
];

export interface PastBug {
  id: string;
  signature: string;
  flowId: string;
  severity: Severity;
  errorMessage: string;
  ageDays: number;
}

export const PAST_BUGS: PastBug[] = [
  {
    id: 'bug_cart_0412',
    signature: "TypeError: Cannot read properties of undefined (reading 'subtotal') @ js/cart.js",
    flowId: 'checkout',
    severity: 'sev2',
    errorMessage: "TypeError: Cannot read properties of undefined (reading 'subtotal')",
    ageDays: 41,
  },
  {
    id: 'bug_cart_0309',
    signature: "TypeError: Cannot read properties of null (reading 'textContent') @ js/cart.js",
    flowId: 'add-to-cart',
    severity: 'sev3',
    errorMessage: "TypeError: Cannot read properties of null (reading 'textContent')",
    ageDays: 58,
  },
  {
    id: 'bug_signup_0227',
    signature: "TypeError: Cannot read properties of null (reading 'value') @ js/signup.js",
    flowId: 'signup',
    severity: 'sev2',
    errorMessage: "TypeError: Cannot read properties of null (reading 'value')",
    ageDays: 77,
  },
];

export interface PastFix {
  id: string;
  bugId: string;
  summary: string;
  rootCause: string;
  files: string[];
  diff: string;
  score: number;
  ageDays: number;
}

export const PAST_FIXES: PastFix[] = [
  {
    id: 'fix_0412',
    bugId: 'bug_cart_0412',
    summary: 'Recompute cart summary when restoring from storage',
    rootCause: 'restoreCart() dropped the summary and computeTotals() read it unguarded.',
    files: ['js/cart.js'],
    diff: `--- a/js/cart.js
+++ b/js/cart.js
@@ -20,4 +20,5 @@
     const parsed = JSON.parse(raw);
-    return { items: parsed.items ?? [], summary: undefined };
+    const items = parsed.items ?? [];
+    return { items, summary: computeSummary(items) };
   } catch {
`,
    score: 92,
    ageDays: 40,
  },
  {
    id: 'fix_0309',
    bugId: 'bug_cart_0309',
    summary: 'Guard the badge update when the header is missing',
    rootCause: 'renderBadge() assumed #cart-badge exists on every page.',
    files: ['js/cart.js'],
    diff: `--- a/js/cart.js
+++ b/js/cart.js
@@ -58,3 +58,4 @@
 export function renderBadge(count) {
-  document.querySelector('#cart-badge').textContent = count;
+  const badge = document.querySelector('#cart-badge');
+  if (badge) badge.textContent = count;
 }
`,
    score: 88,
    ageDays: 57,
  },
  {
    id: 'fix_0227',
    bugId: 'bug_signup_0227',
    summary: 'Look up the email input by name instead of a stale id',
    rootCause: 'The email input was re-rendered with a new id, so the lookup returned null.',
    files: ['js/signup.js'],
    diff: `--- a/js/signup.js
+++ b/js/signup.js
@@ -2,5 +2,5 @@
 export function validateForm(form) {
-  const email = document.getElementById('email');
+  const email = form.querySelector('[name="email"]');
   const password = form.password.value;
-  if (!email.value.includes('@')) return 'Enter a valid email address.';
+  if (!email?.value.includes('@')) return 'Enter a valid email address.';
   if (password.length < 8) return 'Password must be at least 8 characters.';
`,
    score: 90,
    ageDays: 76,
  },
];

export interface PastIncident {
  id: string;
  title: string;
  flowId: string;
  source: 'patrol' | 'manual' | 'flag';
  severity: Severity;
  ageDays: number;
  durationSec: number;
  outcome: 'healed' | 'rolled_back';
  score?: number;
  memoryHit?: string;
  bugId: string;
  fixId?: string;
  error: string;
  note: string;
}

export const PAST_INCIDENTS: PastIncident[] = [
  {
    id: 'inc_mezq3a_c1f0',
    title: 'Checkout total crashes after reload',
    flowId: 'checkout',
    source: 'patrol',
    severity: 'sev2',
    ageDays: 41,
    durationSec: 240,
    outcome: 'healed',
    score: 92,
    bugId: 'bug_cart_0412',
    fixId: 'fix_0412',
    error: "TypeError: Cannot read properties of undefined (reading 'subtotal')",
    note: 'Restored carts get a computed summary; checkout passes.',
  },
  {
    id: 'inc_mf0k7b_9d2e',
    title: 'Badge update throws on header-less pages',
    flowId: 'add-to-cart',
    source: 'manual',
    severity: 'sev3',
    ageDays: 58,
    durationSec: 190,
    outcome: 'healed',
    score: 88,
    bugId: 'bug_cart_0309',
    fixId: 'fix_0309',
    error: "TypeError: Cannot read properties of null (reading 'textContent')",
    note: 'Badge update is guarded when the header is absent.',
  },
  {
    id: 'inc_mf4p1c_2a77',
    title: 'Signup rejects valid emails',
    flowId: 'signup',
    source: 'patrol',
    severity: 'sev2',
    ageDays: 77,
    durationSec: 310,
    outcome: 'healed',
    score: 90,
    bugId: 'bug_signup_0227',
    fixId: 'fix_0227',
    error: "TypeError: Cannot read properties of null (reading 'value')",
    note: 'Email field is looked up by name; signup passes.',
  },
  {
    id: 'inc_mfa8e2_5b10',
    title: 'Checkout total crashes after reload (recurrence)',
    flowId: 'checkout',
    source: 'flag',
    severity: 'sev2',
    ageDays: 12,
    durationSec: 52,
    outcome: 'healed',
    score: 95,
    memoryHit: 'bug_cart_0412',
    bugId: 'bug_cart_0412',
    fixId: 'fix_0412',
    error: "TypeError: Cannot read properties of undefined (reading 'subtotal')",
    note: 'Known bug recalled at 0.91; the earlier fix was re-applied.',
  },
  {
    id: 'inc_mfcz9d_7e3a',
    title: 'Badge update throws on header-less pages (rolled back)',
    flowId: 'add-to-cart',
    source: 'patrol',
    severity: 'sev3',
    ageDays: 6,
    durationSec: 96,
    outcome: 'rolled_back',
    score: 61,
    bugId: 'bug_cart_0309',
    error: "TypeError: Cannot read properties of null (reading 'textContent')",
    note: 'Smoke check failed on canary; the store was rolled back to the previous version.',
  },
];
