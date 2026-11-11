import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  globalTimeout: 5 * 60_000,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'reports/playwright.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // Critical journeys also run on a phone: a control can vanish at narrow widths.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@smoke/ },
  ],
  // The browser tests run against a production build served by `vite preview`, a static server.
  // The dev server transforms modules on demand and optimizes dependencies at first use; inside
  // the agents' sandbox it dropped connections on its first runs and made tests fail on a correct app.
  webServer: {
    command: 'npm run serve:e2e',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { VITE_DEMO_BUG: process.env.VITE_DEMO_BUG || '0' },
  },
});
