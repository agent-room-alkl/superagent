import { test as base, expect } from '@playwright/test';

/** Every test fails on an uncaught page error or console error (prototype QA: "No browser errors"). */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        // HTTP statuses the page renders itself (400 validation, 401/403 role checks, 409 a state conflict the page explains,
        // 503 "not configured") are expected states, not script errors; uncaught exceptions and other console errors still fail.
        if (m.type() === 'error' && !/the server responded with a status of (400|401|403|409|503)\b/.test(m.text())) errors.push(m.text());
      });
      await use(errors);
      expect(errors, 'browser errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
