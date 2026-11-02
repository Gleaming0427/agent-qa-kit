import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const summaryRow = (page: Page, label: string) => page.getByRole('table', { name: 'Order summary' }).getByRole('row', { name: new RegExp(`^${label}`) });
const cartLine = (page: Page, name: string) => page.getByRole('list', { name: 'Cart items' }).getByRole('listitem').filter({ hasText: name });

test.describe('@shop TICKET-42, integrated shell', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[TICKET-42][AC-1] shell lists the products with their prices', async ({ page }) => {
    const items = page.getByRole('list', { name: 'Products' }).getByRole('listitem');
    await expect(items).toHaveCount(4);
    await expect(items.first()).toContainText('Notebook');
    await expect(items.first()).toContainText('€4.50');
    await expect(items.last()).toContainText('Backpack');
    await expect(items.last()).toContainText('€49.00');
  });
  test('[TICKET-42][AC-2] shell subtotal is the sum of price times quantity', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Notebook');
    await add(page, 'Pen set');
    await expect(cartLine(page, 'Notebook')).toContainText('× 2');
    await expect(cartLine(page, 'Pen set')).toContainText('× 1');
    await expect(summaryRow(page, 'Subtotal')).toContainText('€15.00');
  });
  test('[TICKET-42][AC-3] shell shipping is free from €50 and included in the total', async ({ page }) => {
    await add(page, 'Backpack');
    await expect(summaryRow(page, 'Shipping')).toContainText('€4.90');
    await expect(summaryRow(page, 'Total')).toContainText('€53.90');
    await add(page, 'Notebook');
    await expect(summaryRow(page, 'Shipping')).toContainText('Free');
    await expect(summaryRow(page, 'Total')).toContainText('€53.50');
  });
});
