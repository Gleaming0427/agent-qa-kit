import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const addButton = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` });
const line = (page: Page, name: string) => page.getByRole('list', { name: 'Cart items' }).getByRole('listitem').filter({ hasText: name });

test.describe('EVAL-3 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-3][AC-1] Add to cart is disabled at 5 units', async ({ page }) => {
    for (let i = 0; i < 5; i++) await addButton(page, 'Notebook').click();
    await expect(line(page, 'Notebook')).toContainText('× 5');
    await expect(addButton(page, 'Notebook')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Increase Notebook quantity' })).toBeDisabled();
    await expect(addButton(page, 'Pen set')).toBeEnabled();
  });
  test('[EVAL-3][AC-1] the + button stops at 5 units', async ({ page }) => {
    await addButton(page, 'Pen set').click();
    const increase = page.getByRole('button', { name: 'Increase Pen set quantity' });
    for (let i = 0; i < 4; i++) await increase.click();
    await expect(line(page, 'Pen set')).toContainText('× 5');
    await expect(increase).toBeDisabled();
  });
  test('[EVAL-3][AC-2] the line shows "Maximum 5 per product" at 5 units only', async ({ page }) => {
    for (let i = 0; i < 4; i++) await addButton(page, 'Notebook').click();
    await expect(line(page, 'Notebook')).toContainText('× 4');
    await expect(page.getByText('Maximum 5 per product')).toHaveCount(0);
    await addButton(page, 'Notebook').click();
    await expect(line(page, 'Notebook')).toContainText('Maximum 5 per product');
  });
});
