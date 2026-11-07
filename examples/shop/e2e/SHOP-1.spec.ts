import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const summaryRow = (page: Page, label: string) => page.getByRole('table', { name: 'Order summary' }).getByRole('row', { name: new RegExp(`^${label}`) });
const radio = (page: Page, name: string) => page.getByRole('radio', { name });

test.describe('@shop SHOP-1, express delivery', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[SHOP-1][AC-1] shell delivery offers Standard (selected) and Express, standard shipping unchanged', async ({ page }) => {
    await expect(page.getByText('Delivery', { exact: true })).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(2);
    await expect(radio(page, 'Standard')).toBeChecked();
    await expect(radio(page, 'Express')).not.toBeChecked();
    await add(page, 'Notebook');
    await expect(summaryRow(page, 'Shipping')).toContainText('€4.90');
    await expect(summaryRow(page, 'Total')).toContainText('€9.40');
    await add(page, 'Backpack');
    await expect(summaryRow(page, 'Shipping')).toContainText('Free');
    await expect(summaryRow(page, 'Total')).toContainText('€53.50');
  });
  test('[SHOP-1][AC-2] shell express costs €9.90 below and above €50 and is in the total', async ({ page }) => {
    await add(page, 'Notebook');
    await expect(radio(page, 'Express')).toBeVisible();
    await radio(page, 'Express').check();
    await expect(summaryRow(page, 'Shipping')).toContainText('€9.90');
    await expect(summaryRow(page, 'Total')).toContainText('€14.40');
    await add(page, 'Backpack');
    await expect(summaryRow(page, 'Shipping')).toContainText('€9.90');
    await expect(summaryRow(page, 'Total')).toContainText('€63.40');
    await radio(page, 'Standard').check();
    await expect(summaryRow(page, 'Shipping')).toContainText('Free');
    await expect(summaryRow(page, 'Total')).toContainText('€53.50');
  });
  test('[SHOP-1][AC-3] shell empty cart ships nothing with either option', async ({ page }) => {
    await expect(summaryRow(page, 'Shipping')).toContainText('€0.00');
    await expect(summaryRow(page, 'Total')).toContainText('€0.00');
    await expect(radio(page, 'Express')).toBeVisible();
    await radio(page, 'Express').check();
    await expect(summaryRow(page, 'Shipping')).toContainText('€0.00');
    await expect(summaryRow(page, 'Total')).toContainText('€0.00');
  });
});
