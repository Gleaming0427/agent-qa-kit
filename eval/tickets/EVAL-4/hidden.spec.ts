import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const header = (page: Page) => page.locator('header');

test.describe('EVAL-4 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-4][AC-1] the header counts units, starting at 0', async ({ page }) => {
    await expect(header(page)).toContainText('Cart (0)');
    await add(page, 'Notebook');
    await add(page, 'Notebook');
    await add(page, 'Pen set');
    await expect(header(page)).toContainText('Cart (3)');
    await page.getByRole('button', { name: 'Decrease Notebook quantity' }).click();
    await expect(header(page)).toContainText('Cart (2)');
  });
  test('[EVAL-4][AC-2] the header shows Cart (0) after a checkout', async ({ page }) => {
    await add(page, 'Notebook');
    await expect(header(page)).toContainText('Cart (1)');
    await page.getByRole('button', { name: 'Checkout' }).click();
    await expect(page.getByRole('status')).toHaveText('Order confirmed');
    await expect(header(page)).toContainText('Cart (0)');
  });
});
