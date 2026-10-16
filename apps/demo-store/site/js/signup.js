// Newsletter signup: pure email validation plus the DOM wiring for signup.html.
// Top-level code must not touch the DOM unless one exists, so node:test can import this module.

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const MAX_EMAIL_LENGTH = 254;

export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const value = email.trim();
  return value.length > 0 && value.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(value);
}

export function mountSignup(doc) {
  const form = doc.querySelector('[data-testid="signup-form"]');
  if (!form) return;
  const input = doc.querySelector('[data-testid="signup-email"]');
  const error = doc.querySelector('[data-testid="signup-error"]');
  const success = doc.querySelector('[data-testid="signup-success"]');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (isValidEmail(input.value)) {
      error.hidden = true;
      input.removeAttribute('aria-invalid');
      form.hidden = true;
      success.hidden = false;
      return;
    }
    error.textContent = 'Please enter a valid email address, like you@example.com.';
    error.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  });
}

if (typeof document !== 'undefined') mountSignup(document);
