import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, cartTotals, createCart, formatMoney, itemCount, removeItem } from '../site/js/cart.js';

const hoodie = { id: 'neon-hoodie', name: 'Neon Hoodie', priceCents: 4900 };
const tee = { id: 'pixel-tee', name: 'Pixel Tee', priceCents: 2500 };

test('formatMoney turns integer cents into dollars and cents', () => {
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(5), '$0.05');
  assert.equal(formatMoney(4900), '$49.00');
  assert.equal(formatMoney(3920), '$39.20');
});

test('an empty cart has no items and zero totals', () => {
  const cart = createCart();
  assert.equal(itemCount(cart), 0);
  assert.deepEqual(cartTotals(cart), { subtotal: 0, discount: 0, total: 0 });
});

test('adding products without a discount sums their prices', () => {
  let cart = createCart();
  cart = addItem(cart, hoodie);
  cart = addItem(cart, tee);
  assert.equal(itemCount(cart), 2);
  assert.deepEqual(cartTotals(cart), { subtotal: 7400, discount: 0, total: 7400 });
});

test('adding the same product again increases its quantity', () => {
  let cart = createCart();
  cart = addItem(cart, tee);
  cart = addItem(cart, tee);
  assert.equal(itemCount(cart), 2);
  assert.deepEqual(cartTotals(cart), { subtotal: 5000, discount: 0, total: 5000 });
});

test('removing a product takes its price out of the total', () => {
  let cart = addItem(addItem(createCart(), hoodie), tee);
  cart = removeItem(cart, hoodie.id);
  assert.equal(itemCount(cart), 1);
  assert.deepEqual(cartTotals(cart), { subtotal: 2500, discount: 0, total: 2500 });
});
