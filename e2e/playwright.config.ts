import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 3100);

/**
 * End-to-end tests against the real thing: the built API serving the built web
 * bundle, on a real Postgres.
 *
 * These exist because the guarantees this product is sold on are not visible
 * from a unit test. "Two people cannot take the same slot" is a race between
 * browsers; "the webhook decides that money arrived" is about what happens when
 * the browser is lied to. Both were verified by hand, repeatedly, with scripts
 * that were thrown away each time.
 */
export default defineConfig({
  testDir: resolve(__dirname, 'specs'),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // One database, and tests that book real slots in it. Parallel workers would
  // race each other rather than the thing under test.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Artifacts beside the tests rather than at the repository root.
  outputDir: resolve(__dirname, 'test-results'),
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: resolve(__dirname, 'playwright-report') }]]
    : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // Migrates and seeds before booting. That has to happen here rather than in
    // a globalSetup, because Playwright starts this first and the readiness
    // probe it waits on touches the database.
    command: 'npm run e2e:serve',
    url: `http://127.0.0.1:${PORT}/health/ready`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
