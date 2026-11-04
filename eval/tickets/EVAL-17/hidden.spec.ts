import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const row = (page: Page, label: string) => page.getByRole('table', { name: 'Order summary' }).getByRole('row', { name: new RegExp(`^${label}`) });
const wrap = (page: Page) => page.getByRole('checkbox', { name: 'Gift wrap' });

test.describe('EVAL-17 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-17][AC-1] gift wrap counts every unit, and the total includes it', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Notebook');
    await add(page, 'Pen set');
    await wrap(page).check();
    await expect(row(page, 'Gift wrap')).toContainText('€3.00');
    await expect(row(page, 'Shipping')).toContainText('€4.90');
    await expect(row(page, 'Total')).toContainText('€22.90');
  });
  test('[EVAL-17][AC-1] gift wrap does not count toward free shipping', async ({ page }) => {
    await add(page, 'Backpack');
    await wrap(page).check();
    await expect(row(page, 'Gift wrap')).toContainText('€1.00');
    await expect(row(page, 'Shipping')).toContainText('€4.90');
    await expect(row(page, 'Total')).toContainText('€54.90');
  });
  test('[EVAL-17][AC-2] unchecking removes the line and its amount', async ({ page }) => {
    await add(page, 'Notebook');
    await wrap(page).check();
    await expect(row(page, 'Total')).toContainText('€10.40');
    await wrap(page).uncheck();
    await expect(page.getByRole('table', { name: 'Order summary' }).getByRole('row', { name: /^Gift wrap/ })).toHaveCount(0);
    await expect(row(page, 'Total')).toContainText('€9.40');
  });
});
