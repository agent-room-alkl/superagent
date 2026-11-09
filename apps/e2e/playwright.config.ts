import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4173);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw Error('E2E_PORT must be an unprivileged TCP port');
export const OWNER = 'e2e-owner|owner|';
export const EMPLOYEE = 'e2e-employee|employee|P-1';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  // Suites share mutable business-tool/SOP fixtures within one real application process.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    extraHTTPHeaders: { 'x-dev-user': OWNER },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 5'] }, testMatch: /shell\.spec\.ts/ },
  ],
  webServer: {
    command: 'npx tsx server/start.ts',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false, // always a fresh in-memory server: specs must never inherit state from an earlier run
    env: { PORT: String(PORT), NODE_ENV: 'test' },
    timeout: 60_000,
  },
});
