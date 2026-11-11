import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';

afterEach(cleanup);
const add = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Add ${name} to cart` }));
const summaryRow = (label: string) => within(screen.getByRole('table', { name: 'Order summary' })).getByRole('row', { name: new RegExp(`^${label}`) });
const applyCode = (code: string) => {
  fireEvent.change(screen.getByLabelText('Promo code'), { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
};

describe('TICKET-44 MFE: promo code', () => {
  test('[TICKET-44][AC-1] MFE WELCOME10 takes 10% off the subtotal, shipping stays on the undiscounted subtotal', () => {
    render(<App />);
    expect(screen.getByLabelText('Promo code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    // Subtotal 49.00 + 4.50 = 53.50 (free shipping); discounted 48.15 is under 50 but shipping must stay free.
    add('Backpack');
    add('Notebook');
    applyCode('WELCOME10');
    expect(summaryRow('Subtotal')).toHaveTextContent('€53.50');
    expect(summaryRow('Discount')).toHaveTextContent('€5.35');
    expect(summaryRow('Shipping')).toHaveTextContent('Free');
    expect(summaryRow('Total')).toHaveTextContent('€48.15');
  });
  test('[TICKET-44][AC-1] MFE discount on a cart that pays shipping, on a quantity above one', () => {
    render(<App />);
    // Subtotal 2 × 4.50 + 6.00 = 15.00; discount 1.50; shipping 4.90; total 15.00 - 1.50 + 4.90 = 18.40.
    add('Notebook');
    add('Notebook');
    add('Pen set');
    applyCode('WELCOME10');
    expect(summaryRow('Discount')).toHaveTextContent('€1.50');
    expect(summaryRow('Shipping')).toHaveTextContent('€4.90');
    expect(summaryRow('Total')).toHaveTextContent('€18.40');
  });
  test('[TICKET-44][AC-2] MFE an unknown code shows "Invalid code" and leaves the total unchanged', () => {
    render(<App />);
    add('Backpack');
    expect(summaryRow('Total')).toHaveTextContent('€53.90');
    applyCode('BOGUS99');
    expect(screen.getByText(/Invalid code/)).toBeInTheDocument();
    expect(summaryRow('Total')).toHaveTextContent('€53.90');
    expect(screen.queryByRole('row', { name: /^Discount/ })).not.toBeInTheDocument();
  });
});
