import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const row = (page: Page, label: string) => page.getByRole('table', { name: 'Order summary' }).getByRole('row', { name: new RegExp(`^${label}`) });
const lines = (page: Page) => page.getByRole('list', { name: 'Cart items' }).getByRole('listitem');
const line = (page: Page, name: string) => lines(page).filter({ hasText: name });

test.describe('EVAL-16 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-16][AC-1] each line shows price times quantity', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Notebook');
    await add(page, 'Pen set');
    await expect(line(page, 'Notebook')).toContainText('€9.00');
    await expect(line(page, 'Pen set')).toContainText('€6.00');
  });
  test('[EVAL-16][AC-2] amounts keep two decimals', async ({ page }) => {
    await add(page, 'Desk lamp');
    await expect(line(page, 'Desk lamp')).toContainText('€29.90');
  });
});
