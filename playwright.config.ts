import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Un test en échec est rejoué une fois ; s'il passe, il est classé « instable ».
  retries: 1,
  // « dot » garde la console courte ; le JSON alimente qa/summary.mjs.
  reporter: [['dot'], ['json', { outputFile: 'reports/playwright.json' }]],
  use: {
    baseURL: 'http://localhost:9000',
    // La trace est enregistrée au second essai : elle sert de preuve en cas d'échec.
    trace: 'on-first-retry',
  },
  webServer: {
    // À remplacer : la commande qui démarre le shell avec le MFE modifié.
    command: 'yarn start:shell',
    url: 'http://localhost:9000',
    // Toujours démarrer le code courant, jamais un serveur déjà lancé.
    reuseExistingServer: false,
  },
});
