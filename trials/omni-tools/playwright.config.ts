import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // The QA kit's agents write their browser tests in e2e/; the tools' own are next to them in src/.
  testDir: '.',
  testMatch: /(src\/.*\.e2e\.(spec\.)?ts|e2e\/.*\.spec\.ts)$/,
  fullyParallel: true,
  retries: 1,
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry'
  },
  webServer: {
    command: 'npm run build && npm run serve',
    url: 'http://localhost:4173'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
    // The QA kit's workflows install Chromium only.
  ]
});
