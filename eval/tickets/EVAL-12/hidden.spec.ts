import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const row = (page: Page, label: string) => page.getByRole('table', { name: 'Order summary' }).getByRole('row', { name: new RegExp(`^${label}`) });
const lines = (page: Page) => page.getByRole('list', { name: 'Cart items' }).getByRole('listitem');
const line = (page: Page, name: string) => lines(page).filter({ hasText: name });

test.describe('EVAL-12 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-12][AC-1] the hint shows what is left to reach €50.00', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Notebook');
    await expect(page.getByText('Add €41.00 more for free shipping')).toBeVisible();
  });
  test('[EVAL-12][AC-1] the hint follows a single item', async ({ page }) => {
    await add(page, 'Desk lamp');
    await expect(page.getByText('Add €20.10 more for free shipping')).toBeVisible();
  });
  test('[EVAL-12][AC-2] from €50.00 the hint says free shipping is unlocked', async ({ page }) => {
    await add(page, 'Backpack');
    await add(page, 'Notebook');
    await expect(page.getByText('Free shipping unlocked')).toBeVisible();
    await expect(page.getByText(/more for free shipping/)).toHaveCount(0);
  });
  test('[EVAL-12][AC-2] an empty cart shows no hint', async ({ page }) => {
    await expect(page.getByText(/free shipping/i)).toHaveCount(0);
  });
});
