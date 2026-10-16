import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidEmail } from '../site/js/signup.js';

test('accepts ordinary email addresses', () => {
  assert.equal(isValidEmail('ada@lol.store'), true);
  assert.equal(isValidEmail('first.last@example.co.uk'), true);
});

test('rejects empty and malformed addresses', () => {
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail('   '), false);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail('missing-domain@'), false);
  assert.equal(isValidEmail('@lol.store'), false);
  assert.equal(isValidEmail('two@@lol.store'), false);
});

test('ignores surrounding whitespace', () => {
  assert.equal(isValidEmail('  ada@lol.store  '), true);
});

test('rejects non-string input', () => {
  assert.equal(isValidEmail(undefined), false);
  assert.equal(isValidEmail(42), false);
});
