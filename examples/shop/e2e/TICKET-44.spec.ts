import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const summaryRow = (page: Page, label: string) => page.getByRole('table', { name: 'Order summary' }).getByRole('row', { name: new RegExp(`^${label}`) });
const applyCode = async (page: Page, code: string) => {
  await expect(page.getByLabel('Promo code')).toBeVisible();
  await page.getByLabel('Promo code').fill(code);
  await page.getByRole('button', { name: 'Apply' }).click();
};

test.describe('@shop TICKET-44, promo code', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[TICKET-44][AC-1] shell WELCOME10 takes 10% off, shipping stays on the undiscounted subtotal', async ({ page }) => {
    // Subtotal 49.00 + 4.50 = 53.50 (free shipping); discount 5.35; total 48.15.
    await add(page, 'Backpack');
    await add(page, 'Notebook');
    await applyCode(page, 'WELCOME10');
    await expect(summaryRow(page, 'Subtotal')).toContainText('€53.50');
    await expect(summaryRow(page, 'Discount')).toContainText('€5.35');
    await expect(summaryRow(page, 'Shipping')).toContainText('Free');
    await expect(summaryRow(page, 'Total')).toContainText('€48.15');
  });
  test('[TICKET-44][AC-1] shell discount on a cart that pays shipping', async ({ page }) => {
    // Subtotal 2 × 4.50 + 6.00 = 15.00; discount 1.50; shipping 4.90; total 18.40.
    await add(page, 'Notebook');
    await add(page, 'Notebook');
    await add(page, 'Pen set');
    await applyCode(page, 'WELCOME10');
    await expect(summaryRow(page, 'Discount')).toContainText('€1.50');
    await expect(summaryRow(page, 'Shipping')).toContainText('€4.90');
    await expect(summaryRow(page, 'Total')).toContainText('€18.40');
  });
  test('[TICKET-44][AC-2] shell an unknown code shows "Invalid code" and leaves the total unchanged', async ({ page }) => {
    await add(page, 'Backpack');
    await expect(summaryRow(page, 'Total')).toContainText('€53.90');
    await applyCode(page, 'BOGUS99');
    await expect(page.getByText(/Invalid code/)).toBeVisible();
    await expect(summaryRow(page, 'Total')).toContainText('€53.90');
    await expect(page.getByRole('row', { name: /^Discount/ })).toHaveCount(0);
  });
});
