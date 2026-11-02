import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';

afterEach(cleanup);
const add = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Add ${name} to cart` }));
const summaryRow = (label: string) => within(screen.getByRole('table', { name: 'Order summary' })).getByRole('row', { name: new RegExp(`^${label}`) });
const cartLine = (name: string) => within(screen.getByRole('list', { name: 'Cart items' })).getAllByRole('listitem').find((item) => item.textContent?.includes(name));

describe('TICKET-42 MFE: cart total in an isolated shell', () => {
  test('[TICKET-42][AC-1] MFE lists the products with their prices', () => {
    render(<App />);
    const items = within(screen.getByRole('list', { name: 'Products' })).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Notebook');
    expect(items[0]).toHaveTextContent('€4.50');
    expect(items[3]).toHaveTextContent('Backpack');
    expect(items[3]).toHaveTextContent('€49.00');
  });
  test('[TICKET-42][AC-2] MFE subtotal is the sum of price times quantity', () => {
    render(<App />);
    add('Notebook');
    add('Notebook');
    add('Pen set');
    expect(cartLine('Notebook')).toHaveTextContent('× 2');
    expect(cartLine('Pen set')).toHaveTextContent('× 1');
    expect(summaryRow('Subtotal')).toHaveTextContent('€15.00');
  });
  test('[TICKET-42][AC-3] MFE shipping is free from €50 and included in the total', () => {
    render(<App />);
    add('Backpack');
    expect(summaryRow('Shipping')).toHaveTextContent('€4.90');
    expect(summaryRow('Total')).toHaveTextContent('€53.90');
    add('Notebook');
    expect(summaryRow('Shipping')).toHaveTextContent('Free');
    expect(summaryRow('Total')).toHaveTextContent('€53.50');
  });
});
