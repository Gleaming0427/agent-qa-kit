import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const row = (page: Page, label: string) => page.getByRole('table', { name: 'Order summary' }).getByRole('row', { name: new RegExp(`^${label}`) });
const lines = (page: Page) => page.getByRole('list', { name: 'Cart items' }).getByRole('listitem');
const line = (page: Page, name: string) => lines(page).filter({ hasText: name });

test.describe('EVAL-14 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-14][AC-1] the button appears only when the cart has lines', async ({ page }) => {
    await expect(page.getByText('Your cart is empty')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Empty cart' })).toHaveCount(0);
    await add(page, 'Notebook');
    await expect(page.getByRole('button', { name: 'Empty cart' })).toBeVisible();
  });
  test('[EVAL-14][AC-2] the button removes every line', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Pen set');
    await add(page, 'Desk lamp');
    await expect(page.getByRole('button', { name: 'Empty cart' })).toBeVisible();
    await page.getByRole('button', { name: 'Empty cart' }).click();
    await expect(page.getByText('Your cart is empty')).toBeVisible();
    await expect(row(page, 'Subtotal')).toContainText('€0.00');
  });
});
