/**
 * Seeded bugs for the LOL Store. Each seed overwrites one or more site files with a buggy
 * variant (seeds/<seed-id>/<path>, a full copy of the healthy file with one spot changed) and
 * ships exact find/replace edits that turn the buggy file back into the healthy one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BugSeed, SourceFile } from '@healops/shared';

const SEEDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seeds');

function variant(seedId: string, sitePath: string): SourceFile {
  const file = path.join(SEEDS_DIR, seedId, ...sitePath.split('/'));
  return { path: sitePath, content: fs.readFileSync(file, 'utf8') };
}

export const seeds: BugSeed[] = [
  {
    id: 'checkout-discount',
    title: 'Discount code breaks checkout',
    flowId: 'checkout',
    description:
      'Applying LOL20 clears the cached cart totals, but Pay now reads that cache. Clicking Pay now throws ' +
      "\"TypeError: Cannot read properties of undefined (reading 'subtotal')\" in js/cart.js and no order " +
      'confirmation appears. Checkout without a discount code still works.',
    buggyFiles: [variant('checkout-discount', 'js/cart.js')],
    offlineFix: {
      summary: 'Recalculate the cart totals when a discount code is applied',
      rootCause:
        'applyDiscount sets cart.totals to undefined instead of recalculating it, and placeOrder reads that cached snapshot directly.',
      edits: [
        {
          path: 'js/cart.js',
          find: '  cart.totals = undefined; // invalidate; the render path recalculates on demand',
          replace: '  refreshTotals(cart);',
        },
      ],
    },
  },
  {
    id: 'signup-plus-email',
    title: 'Newsletter rejects plus-addressed emails',
    flowId: 'signup',
    description:
      'The email regex lost "+" from its local-part character class, so addresses such as qa+bot@lol.store show ' +
      '"Please enter a valid email address" and cannot subscribe.',
    buggyFiles: [variant('signup-plus-email', 'js/signup.js')],
    offlineFix: {
      summary: 'Allow "+" in the email local part',
      rootCause: 'EMAIL_RE omits "+" from the local-part character class, although email local parts may contain it.',
      edits: [
        {
          path: 'js/signup.js',
          find: 'const EMAIL_RE = /^[A-Za-z0-9._%-]+@',
          replace: 'const EMAIL_RE = /^[A-Za-z0-9._%+-]+@',
        },
      ],
    },
  },
  {
    id: 'cart-overlay',
    title: 'Invisible promo layer blocks Add to cart',
    flowId: 'add-to-cart',
    description:
      'A CSS change adds a free-gift sheen over the product grid that appears once the cart has items. It is ' +
      'missing pointer-events: none, so after the first add it intercepts clicks and the next Add to cart click does nothing.',
    buggyFiles: [variant('cart-overlay', 'css/store.css')],
    offlineFix: {
      summary: 'Let pointer events pass through the free-gift sheen',
      rootCause:
        '.free-gift-sheen becomes visible once the cart has items but does not set pointer-events: none, so it covers the Add to cart buttons.',
      edits: [
        {
          path: 'css/store.css',
          find: '  z-index: 1;\n  visibility: hidden;',
          replace: '  z-index: 1;\n  pointer-events: none;\n  visibility: hidden;',
        },
      ],
    },
  },
  {
    id: 'search-xss',
    title: 'Search box runs HTML from the query (XSS)',
    flowId: 'search',
    description:
      'The no-results message echoes the search query through innerHTML, so a query such as ' +
      '<img src=x onerror=...> runs script in the shopper\'s page: a reflected XSS, the kind of bug that gets a CVE. ' +
      'Searching for normal text still works.',
    buggyFiles: [variant('search-xss', 'js/app.js')],
    offlineFix: {
      summary: 'Render the search query as text, not HTML',
      rootCause:
        'applySearch writes the raw query into noResults.innerHTML, so any HTML in the query is parsed and its event handlers run (reflected XSS).',
      edits: [
        {
          path: 'js/app.js',
          find: '  // echo the query back, highlighted\n  noResults.innerHTML = `No products match "<b>${searchInput.value.trim()}</b>".`;',
          replace: '  noResults.textContent = `No products match "${searchInput.value.trim()}".`;',
        },
      ],
    },
  },
];

export const DEFAULT_SEED = 'checkout-discount';

/** Copy of `files` with the seed's buggy variants overriding the same paths. Throws on an unknown seed id. */
export function applySeed(files: SourceFile[], seedId: string): SourceFile[] {
  const seed = seeds.find((candidate) => candidate.id === seedId);
  if (!seed) {
    throw new Error(`Unknown demo-store seed "${seedId}". Known seeds: ${seeds.map((s) => s.id).join(', ')}`);
  }
  const byPath = new Map<string, string>(files.map((file) => [file.path, file.content]));
  for (const file of seed.buggyFiles) byPath.set(file.path, file.content);
  return [...byPath].map(([filePath, content]) => ({ path: filePath, content }));
}
