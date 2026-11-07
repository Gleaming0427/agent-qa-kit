import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const click = (page: Page, name: string) => page.getByRole('button', { name }).click();

test.describe('@shop SHOP-2, item count in the cart heading', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[SHOP-2][AC-1] shell heading counts each line quantity', async ({ page }) => {
    await click(page, 'Add Notebook to cart');
    await click(page, 'Add Pen set to cart');
    await click(page, 'Add Pen set to cart');
    await expect(page.getByRole('heading', { name: 'Cart (3)', exact: true })).toBeVisible();
  });
  test('[SHOP-2][AC-2] shell empty cart shows Cart (0) at first and after the last item reaches zero', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Cart (0)', exact: true })).toBeVisible();
    await click(page, 'Add Notebook to cart');
    await click(page, 'Add Notebook to cart');
    await expect(page.getByRole('heading', { name: 'Cart (2)', exact: true })).toBeVisible();
    await click(page, 'Decrease Notebook quantity');
    await expect(page.getByRole('heading', { name: 'Cart (1)', exact: true })).toBeVisible();
    await click(page, 'Decrease Notebook quantity');
    await expect(page.getByRole('heading', { name: 'Cart (0)', exact: true })).toBeVisible();
  });
});
