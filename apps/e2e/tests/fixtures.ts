import { test as base, expect } from '@playwright/test';

/** Every test fails on an uncaught page error or console error (prototype QA: "No browser errors"). */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error' && !/status of 40[13]/.test(m.text())) errors.push(m.text());
      });
      await use(errors);
      expect(errors, 'browser errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
