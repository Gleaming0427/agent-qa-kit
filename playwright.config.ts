import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // A failing test is retried once; if it then passes, it is reported as flaky.
  retries: 1,
  // "dot" keeps the console short; the JSON report feeds qa/summary.mjs.
  reporter: [['dot'], ['json', { outputFile: 'reports/playwright.json' }]],
  use: {
    baseURL: 'http://localhost:9000',
    // The trace is recorded on the retry: it serves as evidence when a test fails.
    trace: 'on-first-retry',
  },
  webServer: {
    // Replace with the command that starts the shell with the modified MFE.
    command: 'yarn start:shell',
    url: 'http://localhost:9000',
    // Always start the current code, never a server that is already running.
    reuseExistingServer: false,
  },
});
