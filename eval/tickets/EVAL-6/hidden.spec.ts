import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const product = (page: Page, name: string) => page.getByRole('list', { name: 'Products' }).getByRole('listitem').filter({ hasText: name });

test.describe('EVAL-6 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-6][AC-1] the Desk lamp cannot be added, the others can', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Add Desk lamp to cart' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add Notebook to cart' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Add Backpack to cart' })).toBeEnabled();
  });
  test('[EVAL-6][AC-2] the Desk lamp shows "Out of stock", in-stock products do not', async ({ page }) => {
    await expect(product(page, 'Desk lamp')).toContainText('Out of stock');
    await expect(product(page, 'Notebook')).not.toContainText('Out of stock');
  });
});
