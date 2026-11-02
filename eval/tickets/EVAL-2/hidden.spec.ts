import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const row = (page: Page, label: string) => page.getByRole('table', { name: 'Order summary' }).getByRole('row', { name: new RegExp(`^${label}`) });
const lines = (page: Page) => page.getByRole('list', { name: 'Cart items' }).getByRole('listitem');

test.describe('EVAL-2 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-2][AC-1] Remove deletes the line it belongs to', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Pen set');
    await expect(page.getByRole('button', { name: 'Remove Pen set' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove Pen set' }).click();
    await expect(lines(page)).toHaveCount(1);
    await expect(lines(page)).toContainText('Notebook');
  });
  test('[EVAL-2][AC-1] Remove deletes a line whatever its quantity', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Notebook');
    await add(page, 'Notebook');
    await expect(page.getByRole('button', { name: 'Remove Notebook' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove Notebook' }).click();
    await expect(page.getByText('Your cart is empty')).toBeVisible();
  });
  test('[EVAL-2][AC-2] the subtotal and the total are updated after a removal', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Pen set');
    await expect(page.getByRole('button', { name: 'Remove Pen set' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove Pen set' }).click();
    await expect(row(page, 'Subtotal')).toContainText('€4.50');
    await expect(row(page, 'Total')).toContainText('€9.40');
  });
});
