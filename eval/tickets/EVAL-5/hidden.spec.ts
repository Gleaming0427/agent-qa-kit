import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const names = (page: Page) => page.getByRole('list', { name: 'Products' }).getByRole('listitem').locator('strong');

test.describe('EVAL-5 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-5][AC-1] Sort by offers three orders and defaults to Featured', async ({ page }) => {
    const select = page.getByLabel('Sort by');
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveText(['Featured', 'Price: low to high', 'Price: high to low']);
    await expect(select).toHaveValue(/featured/i);
    await expect(names(page)).toHaveText(['Notebook', 'Pen set', 'Desk lamp', 'Backpack']);
  });
  test('[EVAL-5][AC-2] Price: low to high sorts by increasing price', async ({ page }) => {
    await expect(page.getByLabel('Sort by')).toBeVisible();
    await page.getByLabel('Sort by').selectOption({ label: 'Price: low to high' });
    await expect(names(page)).toHaveText(['Notebook', 'Pen set', 'Desk lamp', 'Backpack']);
  });
  test('[EVAL-5][AC-2] Price: high to low sorts by decreasing price', async ({ page }) => {
    await expect(page.getByLabel('Sort by')).toBeVisible();
    await page.getByLabel('Sort by').selectOption({ label: 'Price: high to low' });
    await expect(names(page)).toHaveText(['Backpack', 'Desk lamp', 'Pen set', 'Notebook']);
  });
});
