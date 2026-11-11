import { expect, test } from '@playwright/test';

test('@smoke a shopper can fill a cart and check out', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Shop', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Products' }).getByRole('listitem')).toHaveCount(4);
  // Kept for the advisory AI visual review (qa/visual-review.ts). It is not compared with an image.
  await page.screenshot({ path: `reports/screens/shop-${testInfo.project.name}.png`, fullPage: true, scale: 'css' });

  // Usable on every screen size: the first product can be added without scrolling, and nothing scrolls sideways.
  const addFirst = page.getByRole('button', { name: 'Add Notebook to cart' });
  await expect(addFirst).toBeInViewport();
  const scrollsSideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(scrollsSideways, 'the page must not scroll sideways').toBe(false);

  await addFirst.click();
  await expect(page.getByRole('list', { name: 'Cart items' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page.getByRole('status')).toHaveText('Order confirmed');
  await expect(page.getByText('Your cart is empty')).toBeVisible();
});
