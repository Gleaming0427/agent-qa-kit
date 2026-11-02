import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const row = (page: Page, label: string) => page.getByRole('table', { name: 'Order summary' }).getByRole('row', { name: new RegExp(`^${label}`) });
async function applyCode(page: Page, code: string) {
  await expect(page.getByLabel('Promo code')).toBeVisible();
  await page.getByLabel('Promo code').fill(code);
  await page.getByRole('button', { name: 'Apply' }).click();
}

test.describe('EVAL-1 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-1][AC-1] WELCOME10 takes 10% off the subtotal and the total includes it', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Notebook');
    await add(page, 'Pen set');
    await applyCode(page, 'WELCOME10');
    await expect(row(page, 'Discount')).toContainText('€1.50');
    await expect(row(page, 'Shipping')).toContainText('€4.90');
    await expect(row(page, 'Total')).toContainText('€18.40');
  });
  test('[EVAL-1][AC-1] shipping is computed on the subtotal before the discount', async ({ page }) => {
    await add(page, 'Backpack');
    await add(page, 'Notebook');
    await applyCode(page, 'WELCOME10');
    await expect(row(page, 'Discount')).toContainText('€5.35');
    await expect(row(page, 'Shipping')).toContainText('Free');
    await expect(row(page, 'Total')).toContainText('€48.15');
  });
  test('[EVAL-1][AC-2] an unknown code shows "Invalid code" and leaves the total unchanged', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Notebook');
    await add(page, 'Pen set');
    await applyCode(page, 'NOPE');
    await expect(page.getByText('Invalid code')).toBeVisible();
    await expect(row(page, 'Total')).toContainText('€19.90');
  });
});
