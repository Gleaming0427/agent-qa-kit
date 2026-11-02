import { expect, test } from '@playwright/test';

test.describe('EVAL-10 hidden reference tests', () => {
  test('[EVAL-10][AC-1] the page shows the number of products under the Shop heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Shop', exact: true })).toBeVisible();
    await expect(page.getByText('4 products', { exact: true })).toBeVisible();
  });
});
