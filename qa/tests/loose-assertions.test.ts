import assert from 'node:assert/strict';
import test from 'node:test';
import { longerValue, looseAssertions } from '../loose-assertions.ts';

test('a number that starts the text, or a whole number that ends it, can grow', () => {
  assert.equal(longerValue('4 products'), '14 products');
  assert.equal(longerValue('3'), '13');
  assert.equal(longerValue('4.90 €'), '14.90 €');
  assert.equal(longerValue('× 1'), '× 10');
  assert.equal(longerValue('Total 9'), 'Total 90');
  // Text around the number protects it, and a decimal part ends an amount.
  assert.equal(longerValue('€4.90'), null);
  assert.equal(longerValue('€1,50'), null);
  assert.equal(longerValue('Cart (3)'), null);
  assert.equal(longerValue('Add €1.00 more for free shipping'), null);
  assert.equal(longerValue('${count} products'), null);
});

// From the browser tests the writer generated in the campaigns of 5 and 7 November.
const spec = `import { expect, test } from '@playwright/test';
test('[EVAL-10][AC-1] shell lists the products', async ({ page }) => {
  await page.getByText('4 products').click();
  await expect(page.getByText('4 products')).toBeVisible();
  await expect(page.getByText('4 products', { exact: true })).toBeVisible();
  await expect(page.getByText('3 products')).toHaveCount(0);
  await expect(page.getByText('2 products')).not.toBeVisible();
  const line = page.getByRole('listitem').filter({ hasText: 'Notebook' });
  await expect(line).toContainText('× 1');
  await expect(line).not.toContainText('× 2');
  await expect(page.getByRole('row', { name: 'Total' })).toContainText('€4.90');
  await expect(page.getByRole('heading', { name: 'Cart (3)' })).toBeVisible();
  await expect(page.getByRole('status', { name: '2 items' })).toBeVisible();
  await expect(
    page.getByLabel('Quantity 3'),
  ).toBeVisible();
  await expect.soft(page.getByText('a) 4')).toBeVisible();
});
`;

test('only the assertions that would pass on a longer number are listed, with that number', () => {
  assert.deepEqual(looseAssertions(spec), [
    { line: 4, code: "getByText('4 products')", accepts: '14 products' },
    { line: 9, code: "toContainText('× 1')", accepts: '× 10' },
    { line: 13, code: "getByRole('status', { name: '2 items' })", accepts: '12 items' },
    { line: 15, code: "getByLabel('Quantity 3')", accepts: 'Quantity 30' },
    { line: 17, code: "getByText('a) 4')", accepts: 'a) 40' },
  ]);
});

test('a file with no such assertion gives nothing', () => {
  assert.deepEqual(looseAssertions("await expect(page.getByRole('heading', { name: 'Cart (3)', exact: true })).toBeVisible();\n"), []);
  assert.deepEqual(looseAssertions(''), []);
});
