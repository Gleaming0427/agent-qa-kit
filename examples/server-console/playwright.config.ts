import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  globalTimeout: 5 * 60_000,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'reports/playwright.json' }]],
  // Screenshot baselines are made on Linux CI; fonts render differently elsewhere.
  ignoreSnapshots: !process.env.CI,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // Critical journeys also run on a phone: a control can vanish at narrow widths.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@smoke/ },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 30_000,
    env: { VITE_DEMO_BUG: process.env.VITE_DEMO_BUG || '0' },
  },
});
