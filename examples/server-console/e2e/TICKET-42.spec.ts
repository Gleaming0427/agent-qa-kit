import { expect, test } from '@playwright/test';

test.describe('@services TICKET-42, integrated shell', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test('[TICKET-42][AC-1] shell lists all services', async ({ page }) => {
    await expect(page.getByRole('list', { name: 'Available services' }).getByRole('listitem')).toHaveCount(3);
  });
  test('[TICKET-42][AC-2] shell filters case insensitively', async ({ page }) => {
    await page.getByRole('searchbox', { name: 'Search services' }).fill('ALPHA');
    await expect(page.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('listitem')).toContainText('Alpha');
  });
  test('[TICKET-42][AC-3] shell displays the empty-state message', async ({ page }) => {
    await page.getByRole('searchbox', { name: 'Search services' }).fill('does-not-exist');
    await expect(page.getByRole('status')).toHaveText('No service found');
  });
});
