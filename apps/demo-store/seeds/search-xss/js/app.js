// Shop page wiring (index.html). All cart state lives in cart.js; this file only renders it.
import {
  addItem,
  applyDiscount,
  cartTotals,
  createCart,
  formatMoney,
  itemCount,
  placeOrder,
  removeItem,
} from './cart.js';

const $ = (testId) => document.querySelector(`[data-testid="${testId}"]`);

const grid = $('product-grid');
const searchInput = $('search');
const noResults = $('no-results');
const cartCount = $('cart-count');
const cartEmpty = $('cart-empty');
const cartLines = $('cart-lines');
const subtotalOut = $('cart-subtotal');
const discountRow = $('discount-row');
const discountOut = $('cart-discount');
const totalOut = $('cart-total');
const discountForm = $('discount-form');
const discountInput = $('discount-input');
const discountMessage = $('discount-message');
const payButton = $('pay-now');
const confirmation = $('order-confirmation');
const orderIdOut = $('order-id');
const orderTotalOut = $('order-total');

let cart = createCart();
let cards = [];

function el(tag, attrs, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

function initials(name) {
  return name.split(' ').map((word) => word[0]).join('').slice(0, 2).toUpperCase();
}

function buildCard(product) {
  const art = el('div', { class: 'card-art', 'aria-hidden': 'true' }, [
    el('span', { class: 'card-initials', text: initials(product.name) }),
  ]);
  art.style.setProperty('--hue', String(product.hue ?? 260));

  const addButton = el('button', { type: 'button', class: 'btn', 'data-testid': 'add-to-cart', text: 'Add to cart' });
  addButton.addEventListener('click', () => {
    cart = addItem(cart, product);
    render();
  });

  const body = el('div', { class: 'card-body' }, [
    el('h2', { class: 'card-title', text: product.name }),
    el('p', { class: 'card-blurb', text: product.blurb }),
    el('div', { class: 'card-foot' }, [
      el('span', { class: 'price', text: formatMoney(product.priceCents) }),
      addButton,
    ]),
  ]);

  return el('article', { class: 'card', 'data-testid': 'product', 'data-product-id': product.id }, [art, body]);
}

function buildLine(item) {
  const remove = el('button', { type: 'button', class: 'link', 'data-testid': 'remove-item', text: 'Remove' });
  remove.addEventListener('click', () => {
    cart = removeItem(cart, item.id);
    render();
  });
  return el('li', { class: 'cart-line', 'data-testid': 'cart-line' }, [
    el('div', {}, [
      el('div', { class: 'line-name', text: item.name }),
      el('div', { class: 'line-meta', text: `${item.qty} × ${formatMoney(item.priceCents)}` }),
    ]),
    el('div', { class: 'line-end' }, [
      el('div', { class: 'price', text: formatMoney(item.priceCents * item.qty) }),
      remove,
    ]),
  ]);
}

function render() {
  const totals = cartTotals(cart);
  cartCount.textContent = String(itemCount(cart));
  cartEmpty.hidden = cart.items.length > 0;
  cartLines.replaceChildren(...cart.items.map(buildLine));
  subtotalOut.textContent = formatMoney(totals.subtotal);
  discountRow.hidden = totals.discount === 0;
  discountOut.textContent = `-${formatMoney(totals.discount)}`;
  totalOut.textContent = formatMoney(totals.total);
}

function setMessage(text, tone) {
  discountMessage.textContent = text;
  discountMessage.className = tone ? `discount-message is-${tone}` : 'discount-message';
}

function applySearch() {
  if (cards.length === 0) return;
  const query = searchInput.value.trim().toLowerCase();
  let matches = 0;
  for (const { product, card } of cards) {
    const haystack = `${product.name} ${product.blurb}`.toLowerCase();
    const show = query === '' || haystack.includes(query);
    card.hidden = !show;
    if (show) matches += 1;
  }
  // echo the query back, highlighted
  noResults.innerHTML = `No products match "<b>${searchInput.value.trim()}</b>".`;
  noResults.hidden = matches > 0;
}

function newOrderId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const salt = Math.floor(Math.random() * 36 ** 3).toString(36).toUpperCase().padStart(3, '0');
  return `${stamp}${salt}`;
}

discountForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const result = applyDiscount(cart, discountInput.value);
  if (result.ok) setMessage(`${result.code} applied: ${result.label}.`, 'ok');
  else setMessage(result.error, 'error');
  render();
});

payButton.addEventListener('click', () => {
  if (cart.items.length === 0) {
    setMessage('Add something to your cart first.', 'error');
    return;
  }
  const order = placeOrder(cart, newOrderId());
  orderIdOut.textContent = order.id;
  orderTotalOut.textContent = formatMoney(order.total);
  confirmation.hidden = false;
  cart = createCart();
  discountInput.value = '';
  setMessage('', '');
  render();
  confirmation.scrollIntoView({ block: 'start' });
  location.hash = `order-${order.id}`;
});

async function init() {
  if (!grid) return;
  try {
    const response = await fetch('data/products.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`products.json returned HTTP ${response.status}`);
    const products = await response.json();
    cards = products.map((product) => ({ product, card: buildCard(product) }));
    grid.replaceChildren(...cards.map(({ card }) => card));
  } catch (err) {
    grid.textContent = 'Could not load the products. Please refresh the page.';
    console.error(err);
  }
  searchInput.addEventListener('input', applySearch);
  render();
}

init();
