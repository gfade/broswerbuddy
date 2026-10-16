// Pure cart logic: no DOM access, so the same module runs in the browser and under node:test.
// Money is always integer cents. Mutators update the cart in place and return it.

export const DISCOUNT_CODES = Object.freeze({
  LOL20: Object.freeze({ percent: 20, label: '20% off' }),
});

export function createCart() {
  return refreshTotals({ items: [], discountCode: null, totals: null });
}

/** Re-computes the cached totals snapshot that placeOrder() reads. */
function refreshTotals(cart) {
  cart.totals = cartTotals(cart);
  return cart;
}

export function addItem(cart, product) {
  const line = cart.items.find((item) => item.id === product.id);
  if (line) {
    line.qty += 1;
  } else {
    cart.items.push({ id: product.id, name: product.name, priceCents: product.priceCents, qty: 1 });
  }
  return refreshTotals(cart);
}

export function removeItem(cart, productId) {
  cart.items = cart.items.filter((item) => item.id !== productId);
  return refreshTotals(cart);
}

export function applyDiscount(cart, code) {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false, error: 'Enter a discount code.' };
  if (!Object.hasOwn(DISCOUNT_CODES, normalized)) return { ok: false, error: 'That code is not valid.' };
  cart.discountCode = normalized;
  cart.totals = undefined; // invalidate; the render path recalculates on demand
  return { ok: true, code: normalized, label: DISCOUNT_CODES[normalized].label };
}

/** Totals computed from the cart contents (used for display, always fresh). */
export function cartTotals(cart) {
  const subtotal = cart.items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
  const rule = cart.discountCode ? DISCOUNT_CODES[cart.discountCode] : undefined;
  const discount = rule ? Math.round((subtotal * rule.percent) / 100) : 0;
  return { subtotal, discount, total: subtotal - discount };
}

export function itemCount(cart) {
  return cart.items.reduce((sum, item) => sum + item.qty, 0);
}

/** Pay path: builds the order from the cart's cached totals snapshot. */
export function placeOrder(cart, orderId) {
  if (cart.items.length === 0) throw new Error('Cannot place an order for an empty cart');
  const subtotal = cart.totals.subtotal;
  const discount = cart.totals.discount;
  const total = cart.totals.total;
  return {
    id: orderId,
    items: cart.items.map((item) => ({ ...item })),
    code: cart.discountCode,
    subtotal,
    discount,
    total,
  };
}

/** 1234 -> "$12.34", -980 -> "-$9.80". */
export function formatMoney(cents) {
  const value = Math.round(Number(cents) || 0);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars}.${rest}`;
}

function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase();
}
