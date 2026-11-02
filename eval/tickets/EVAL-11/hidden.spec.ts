import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const row = (page: Page, label: string) => page.getByRole('table', { name: 'Order summary' }).getByRole('row', { name: new RegExp(`^${label}`) });
const lines = (page: Page) => page.getByRole('list', { name: 'Cart items' }).getByRole('listitem');
const line = (page: Page, name: string) => lines(page).filter({ hasText: name });

test.describe('EVAL-11 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-11][AC-1] the field sets the quantity of its own line', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Pen set');
    await expect(page.getByLabel('Pen set quantity')).toBeVisible();
    await page.getByLabel('Pen set quantity').fill('3');
    await expect(line(page, 'Pen set')).toContainText('× 3');
    await expect(line(page, 'Notebook')).toContainText('× 1');
    await expect(row(page, 'Subtotal')).toContainText('€22.50');
  });
  test('[EVAL-11][AC-1] the field shows the quantity and updates the total', async ({ page }) => {
    await add(page, 'Desk lamp');
    await expect(page.getByLabel('Desk lamp quantity')).toHaveValue('1');
    await page.getByLabel('Desk lamp quantity').fill('2');
    await expect(row(page, 'Total')).toContainText('€59.80');
  });
  test('[EVAL-11][AC-2] entering 0 removes the line', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Pen set');
    await expect(page.getByLabel('Pen set quantity')).toBeVisible();
    await page.getByLabel('Pen set quantity').fill('0');
    await expect(lines(page)).toHaveCount(1);
    await expect(lines(page)).toContainText('Notebook');
  });
});
