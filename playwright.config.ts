import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // A failing test is retried once; if it then passes, it is reported as flaky.
  retries: 1,
  // "dot" keeps the console short; the JSON report feeds qa/summary.ts.
  reporter: [['dot'], ['json', { outputFile: 'reports/playwright.json' }]],
  // Screenshot baselines are made on Linux CI; fonts render differently elsewhere.
  ignoreSnapshots: !process.env.CI,
  use: {
    baseURL: 'http://localhost:9000',
    // The trace is recorded on the retry: it serves as evidence when a test fails.
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // The fixed @smoke journeys also run on a phone.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@smoke/ },
  ],
  webServer: {
    // Replace with the command that starts the shell with the modified MFE.
    command: 'yarn start:shell',
    url: 'http://localhost:9000',
    // Always start the current code, never a server that is already running.
    reuseExistingServer: false,
  },
});
