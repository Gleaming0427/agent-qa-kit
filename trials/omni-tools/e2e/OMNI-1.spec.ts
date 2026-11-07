import { expect, test } from '@playwright/test';

test.describe('@omni OMNI-1', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/string/reverse');
  });

  test('[OMNI-1][AC-1] reverse word order is off at first and reverses words when on', async ({
    page
  }) => {
    const option = page.getByLabel('Reverse word order');
    await expect(option).toBeVisible();
    await expect(option).not.toBeChecked();

    await page.getByTestId('text-input').fill('Hello big world');
    await option.check();
    await expect(page.getByTestId('text-result')).toHaveValue(
      'world big Hello'
    );
  });

  test('[OMNI-1][AC-2] with multi-line on, words of each line are reversed separately', async ({
    page
  }) => {
    const option = page.getByLabel('Reverse word order');
    await expect(option).toBeVisible();
    const multiLine = page.getByLabel('Process multi-line text');
    await expect(multiLine).toBeChecked();

    await page.getByTestId('text-input').fill('one two\nthree four');
    await option.check();
    await expect(page.getByTestId('text-result')).toHaveValue(
      'two one\nfour three'
    );
  });

  test('[OMNI-1][AC-3] with reverse word order off, characters are reversed', async ({
    page
  }) => {
    const option = page.getByLabel('Reverse word order');
    await expect(option).toBeVisible();
    await expect(option).not.toBeChecked();

    await page.getByTestId('text-input').fill('Hello World');
    await expect(page.getByTestId('text-result')).toHaveValue('dlroW olleH');

    // turning it on and off again returns to character reversal
    await option.check();
    await expect(page.getByTestId('text-result')).toHaveValue('World Hello');
    await option.uncheck();
    await expect(page.getByTestId('text-result')).toHaveValue('dlroW olleH');
  });
});
