import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against the Compose stack: `docker compose -f infra/docker-compose.yml up`.
 * E2E_BASE_URL and MAILPIT_URL point at it. Raise RATE_LIMIT_AUTH_PER_MIN for the stack under test,
 * since every browser in the run shares one IP.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
});
