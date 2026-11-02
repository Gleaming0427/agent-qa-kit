import { describe, expect, test } from 'vitest';
import { FREE_SHIPPING_FROM_CENTS, SHIPPING_CENTS, addToCart, changeQuantity, formatPrice, shipping } from './cart';

describe('cart rules', () => {
  test('shipping is charged below the threshold and free from it', () => {
    expect(shipping(0)).toBe(0);
    expect(shipping(FREE_SHIPPING_FROM_CENTS - 1)).toBe(SHIPPING_CENTS);
    expect(shipping(FREE_SHIPPING_FROM_CENTS)).toBe(0);
  });
  test('prices are shown in euros with two decimals', () => {
    expect(formatPrice(450)).toBe('€4.50');
    expect(formatPrice(5350)).toBe('€53.50');
  });
  test('adding a product twice raises its quantity, and a quantity of zero removes the line', () => {
    const lines = addToCart(addToCart([], 'notebook'), 'notebook');
    expect(lines).toEqual([{ productId: 'notebook', quantity: 2 }]);
    expect(changeQuantity(changeQuantity(lines, 'notebook', -1), 'notebook', -1)).toEqual([]);
  });
});
