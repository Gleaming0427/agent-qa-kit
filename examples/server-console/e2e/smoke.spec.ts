import { expect, test } from '@playwright/test';

test('@smoke a user can find a service and see an empty result', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Available services' }).getByRole('listitem')).toHaveCount(3);

  const search = page.getByRole('searchbox', { name: 'Search services' });
  await search.fill('ALPHA');
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('listitem')).toContainText('Alpha');

  await search.fill('missing-service');
  await expect(page.getByRole('status')).toHaveText('No service found');
});
