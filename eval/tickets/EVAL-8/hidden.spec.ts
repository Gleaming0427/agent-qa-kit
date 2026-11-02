import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const add = (page: Page, name: string) => page.getByRole('button', { name: `Add ${name} to cart` }).click();
const bar = (page: Page) => page.getByRole('region', { name: 'Checkout bar' });

test.use({ viewport: { width: 412, height: 839 } });

test.describe('EVAL-8 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-8][AC-1] on a phone screen, the bar and its Checkout button are visible without scrolling', async ({ page }) => {
    await add(page, 'Notebook');
    await expect(bar(page)).toBeVisible();
    await expect(bar(page)).toBeInViewport();
    await expect(bar(page).getByRole('button', { name: 'Checkout' })).toBeInViewport();
  });
  test('[EVAL-8][AC-2] the bar shows the order total, shipping included', async ({ page }) => {
    await add(page, 'Notebook');
    await add(page, 'Notebook');
    await add(page, 'Pen set');
    await expect(bar(page)).toContainText('€19.90');
    await add(page, 'Backpack');
    await expect(bar(page)).toContainText('€64.00');
  });
});
