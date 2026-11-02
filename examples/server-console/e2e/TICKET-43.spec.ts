import { expect, test } from '@playwright/test';

test.describe('@services TICKET-43', () => {
  test('[TICKET-43][AC-1] the Clear search button is displayed only while the search field has text', async ({ page }) => {
    await page.goto('/');
    const search = page.getByRole('searchbox', { name: 'Search services' });
    const clear = page.getByRole('button', { name: 'Clear search' });
    await expect(clear).toBeHidden();

    await search.fill('alpha');
    await expect(clear).toBeVisible();

    await search.fill('');
    await expect(clear).toBeHidden();
  });

  test('[TICKET-43][AC-2] clicking Clear search empties the field and lists all services again', async ({ page }) => {
    await page.goto('/');
    const search = page.getByRole('searchbox', { name: 'Search services' });
    const items = page.getByRole('list', { name: 'Available services' }).getByRole('listitem');
    await search.fill('alpha');
    await expect(items).toHaveCount(1);

    const clear = page.getByRole('button', { name: 'Clear search' });
    await expect(clear).toBeVisible();
    await clear.click();

    await expect(search).toHaveValue('');
    await expect(items).toHaveCount(3);
  });
});
