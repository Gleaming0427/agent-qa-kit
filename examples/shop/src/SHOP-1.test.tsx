import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';

afterEach(cleanup);
const add = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Add ${name} to cart` }));
const summaryRow = (label: string) => within(screen.getByRole('table', { name: 'Order summary' })).getByRole('row', { name: new RegExp(`^${label}`) });
const choose = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));

describe('SHOP-1 MFE: express delivery', () => {
  test('[SHOP-1][AC-1] MFE delivery offers Standard (selected) and Express, standard shipping unchanged', () => {
    render(<App />);
    expect(screen.getByText('Delivery')).toBeVisible();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Standard' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Express' })).not.toBeChecked();
    add('Notebook');
    expect(summaryRow('Shipping')).toHaveTextContent('€4.90');
    expect(summaryRow('Total')).toHaveTextContent('€9.40');
    add('Backpack');
    expect(summaryRow('Shipping')).toHaveTextContent('Free');
    expect(summaryRow('Total')).toHaveTextContent('€53.50');
  });
  test('[SHOP-1][AC-2] MFE express costs €9.90 below and above €50 and is in the total', () => {
    render(<App />);
    add('Notebook');
    choose('Express');
    expect(summaryRow('Shipping')).toHaveTextContent('€9.90');
    expect(summaryRow('Total')).toHaveTextContent('€14.40');
    add('Backpack');
    expect(summaryRow('Shipping')).toHaveTextContent('€9.90');
    expect(summaryRow('Total')).toHaveTextContent('€63.40');
    choose('Standard');
    expect(summaryRow('Shipping')).toHaveTextContent('Free');
    expect(summaryRow('Total')).toHaveTextContent('€53.50');
  });
  test('[SHOP-1][AC-3] MFE empty cart ships nothing with either option', () => {
    render(<App />);
    expect(summaryRow('Shipping')).toHaveTextContent('€0.00');
    expect(summaryRow('Total')).toHaveTextContent('€0.00');
    choose('Express');
    expect(summaryRow('Shipping')).toHaveTextContent('€0.00');
    expect(summaryRow('Total')).toHaveTextContent('€0.00');
  });
});
