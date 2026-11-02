import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const row = (page: Page, label: string) => page.getByRole('table', { name: 'Order summary' }).getByRole('row', { name: new RegExp(`^${label}`) });
const lines = (page: Page) => page.getByRole('list', { name: 'Cart items' }).getByRole('listitem');
const line = (page: Page, name: string) => lines(page).filter({ hasText: name });

test.describe('EVAL-15 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  const products = (page: Page) => page.getByRole('list', { name: 'Products' }).getByRole('listitem');
  test('[EVAL-15][AC-1] the search ignores the case', async ({ page }) => {
    await expect(page.getByLabel('Search products')).toBeVisible();
    await page.getByLabel('Search products').fill('pen');
    await expect(products(page)).toHaveCount(1);
    await expect(products(page)).toContainText('Pen set');
  });
  test('[EVAL-15][AC-1] clearing the search shows every product', async ({ page }) => {
    await expect(page.getByLabel('Search products')).toBeVisible();
    await page.getByLabel('Search products').fill('lamp');
    await expect(products(page)).toHaveCount(1);
    await page.getByLabel('Search products').fill('');
    await expect(products(page)).toHaveCount(4);
  });
  test('[EVAL-15][AC-2] no match shows a message', async ({ page }) => {
    await expect(page.getByLabel('Search products')).toBeVisible();
    await page.getByLabel('Search products').fill('chair');
    await expect(page.getByText('No products found')).toBeVisible();
    await expect(products(page)).toHaveCount(0);
  });
});
