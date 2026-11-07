import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';

afterEach(cleanup);
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('SHOP-2 MFE: item count in the cart heading', () => {
  test('[SHOP-2][AC-1] MFE heading counts each line quantity', () => {
    render(<App />);
    add2();
    expect(screen.getByRole('heading', { name: 'Cart (3)' })).toBeVisible();
  });
  test('[SHOP-2][AC-2] MFE empty cart shows Cart (0) at first and after the last item reaches zero', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Cart (0)' })).toBeVisible();
    click('Add Notebook to cart');
    click('Add Notebook to cart');
    expect(screen.getByRole('heading', { name: 'Cart (2)' })).toBeVisible();
    click('Decrease Notebook quantity');
    expect(screen.getByRole('heading', { name: 'Cart (1)' })).toBeVisible();
    click('Decrease Notebook quantity');
    expect(screen.getByRole('heading', { name: 'Cart (0)' })).toBeVisible();
  });
});

function add2() {
  click('Add Notebook to cart');
  click('Add Pen set to cart');
  click('Add Pen set to cart');
}
