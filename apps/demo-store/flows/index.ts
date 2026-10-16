/**
 * Browser flows for the LOL Store. Each flow drives the storefront with Playwright and selects
 * elements by data-testid. Every action and assertion has an explicit 5000ms timeout so a broken
 * flow fails fast.
 */
import type { FlowDefinition } from '@healops/shared';
import type { Locator, Page } from 'playwright-core';

const T = 5000;

/** Waits until an element matching `locator` is visible and contains `text` (substring or RegExp). */
async function expectVisible(locator: Locator, text: string | RegExp): Promise<void> {
  await locator.filter({ hasText: text }).first().waitFor({ state: 'visible', timeout: T });
}

function productCard(page: Page, name: string): Locator {
  return page.getByTestId('product').filter({ hasText: name });
}

const checkout: FlowDefinition = {
  id: 'checkout',
  name: 'Checkout with discount code',
  description:
    'Add the Neon Hoodie, apply LOL20 (20% off), pay now and expect the order confirmation with the order id in the URL hash.',
  critical: true,
  async run({ page, baseUrl, step }) {
    await step('Open store', async () => {
      await page.goto(`${baseUrl}/index.html`, { timeout: T });
      await page.getByTestId('product').first().waitFor({ state: 'visible', timeout: T });
    });
    await step('Add Neon Hoodie to cart', async () => {
      await productCard(page, 'Neon Hoodie').getByTestId('add-to-cart').click({ timeout: T });
      await expectVisible(page.getByTestId('cart-count'), /^1$/);
    });
    await step('Apply code LOL20', async () => {
      await page.getByTestId('discount-input').fill('LOL20', { timeout: T });
      await page.getByTestId('apply-discount').click({ timeout: T });
      await expectVisible(page.getByTestId('cart-total'), '$39.20');
    });
    await step('Pay now', async () => {
      await page.getByTestId('pay-now').click({ timeout: T });
    });
    await step('See order confirmation', async () => {
      await expectVisible(page.getByTestId('order-confirmation'), 'Order confirmed');
      await page.waitForFunction("location.hash.startsWith('#order-')", undefined, { timeout: T });
    });
  },
};

const addToCart: FlowDefinition = {
  id: 'add-to-cart',
  name: 'Add to cart',
  description: 'Add the Neon Hoodie and the Pixel Tee to the cart and expect the cart count to read 2.',
  critical: true,
  async run({ page, baseUrl, step }) {
    await step('Open store', async () => {
      await page.goto(`${baseUrl}/index.html`, { timeout: T });
      await page.getByTestId('product').first().waitFor({ state: 'visible', timeout: T });
    });
    await step('Add Neon Hoodie to cart', async () => {
      await productCard(page, 'Neon Hoodie').getByTestId('add-to-cart').click({ timeout: T });
      await expectVisible(page.getByTestId('cart-count'), /^1$/);
    });
    await step('Add Pixel Tee to cart', async () => {
      await productCard(page, 'Pixel Tee').getByTestId('add-to-cart').click({ timeout: T });
    });
    await step('Check cart count is 2', async () => {
      await expectVisible(page.getByTestId('cart-count'), /^2$/);
    });
  },
};

const signup: FlowDefinition = {
  id: 'signup',
  name: 'Newsletter signup',
  description: 'Subscribe qa+bot@lol.store to the newsletter and expect the "You\'re in!" success message.',
  critical: true,
  async run({ page, baseUrl, step }) {
    await step('Open signup page', async () => {
      await page.goto(`${baseUrl}/signup.html`, { timeout: T });
      await page.getByTestId('signup-form').waitFor({ state: 'visible', timeout: T });
    });
    await step('Enter qa+bot@lol.store', async () => {
      await page.getByTestId('signup-email').fill('qa+bot@lol.store', { timeout: T });
    });
    await step('Submit signup form', async () => {
      await page.getByTestId('signup-submit').click({ timeout: T });
    });
    await step('See success message', async () => {
      await expectVisible(page.getByTestId('signup-success'), "You're in!");
    });
  },
};

export const flows: FlowDefinition[] = [checkout, addToCart, signup];

export function getFlow(id: string): FlowDefinition | undefined {
  return flows.find((flow) => flow.id === id);
}
