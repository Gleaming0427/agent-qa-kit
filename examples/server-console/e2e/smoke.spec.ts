import { expect, test } from '@playwright/test';

test('@smoke a user can find a service and see an empty result', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Available services' }).getByRole('listitem')).toHaveCount(3);
  // Compared in CI with the committed baseline, one image per project.
  await expect(page).toHaveScreenshot('services.png', { fullPage: true });

  // Usable on every screen size: the search box is in view and nothing scrolls sideways.
  const search = page.getByRole('searchbox', { name: 'Search services' });
  await expect(search).toBeInViewport();
  const scrollsSideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(scrollsSideways, 'the page must not scroll sideways').toBe(false);

  await search.fill('ALPHA');
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('listitem')).toContainText('Alpha');

  await search.fill('missing-service');
  await expect(page.getByRole('status')).toHaveText('No service found');
});
