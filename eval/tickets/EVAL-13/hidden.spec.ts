import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const row = (page: Page, label: string) => page.getByRole('table', { name: 'Order summary' }).getByRole('row', { name: new RegExp(`^${label}`) });
const lines = (page: Page) => page.getByRole('list', { name: 'Cart items' }).getByRole('listitem');
const line = (page: Page, name: string) => lines(page).filter({ hasText: name });

test.describe('EVAL-13 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-13][AC-1] a line of 3 units gets 10% off and a badge', async ({ page }) => {
    for (let i = 0; i < 3; i++) await add(page, 'Notebook');
    await expect(line(page, 'Notebook')).toContainText('−10%');
    await expect(row(page, 'Subtotal')).toContainText('€12.15');
  });
  test('[EVAL-13][AC-1] a line of 2 units keeps its full price', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Notebook');
    await expect(row(page, 'Subtotal')).toContainText('€9.00');
    await expect(line(page, 'Notebook')).not.toContainText('−10%');
  });
  test('[EVAL-13][AC-2] only the qualifying line is discounted', async ({ page }) => {
    for (let i = 0; i < 3; i++) await add(page, 'Notebook');
    await add(page, 'Pen set');
    await expect(row(page, 'Subtotal')).toContainText('€18.15');
    await expect(row(page, 'Total')).toContainText('€23.05');
  });
});
