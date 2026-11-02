import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function checkoutWith(page: Page, email: string) {
  await page.getByRole('button', { name: 'Add Notebook to cart' }).click();
  await expect(page.getByLabel('Email for receipt')).toBeVisible();
  await page.getByLabel('Email for receipt').fill(email);
  await page.getByRole('button', { name: 'Checkout' }).click();
}

test.describe('EVAL-7 hidden reference tests', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[EVAL-7][AC-1] an invalid address blocks the checkout with a message', async ({ page }) => {
    await checkoutWith(page, 'name@');
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
    await expect(page.getByText('Order confirmed')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Cart items' }).getByRole('listitem')).toHaveCount(1);
  });
  test('[EVAL-7][AC-1] the field is optional', async ({ page }) => {
    await checkoutWith(page, '');
    await expect(page.getByRole('status')).toHaveText('Order confirmed');
  });
  test('[EVAL-7][AC-2] a valid address confirms the order and the receipt', async ({ page }) => {
    await checkoutWith(page, 'ana@example.com');
    await expect(page.getByRole('status')).toHaveText('Order confirmed');
    await expect(page.getByText('Receipt sent to ana@example.com')).toBeVisible();
  });
});
