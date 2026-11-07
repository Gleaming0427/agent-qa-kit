// Prices are whole cents, so totals never suffer from floating-point rounding.
export type Product = { id: string; name: string; priceCents: number };
export type CartLine = { productId: string; quantity: number };

export const PRODUCTS: Product[] = [
  { id: 'notebook', name: 'Notebook', priceCents: 450 },
  { id: 'pen-set', name: 'Pen set', priceCents: 600 },
  { id: 'desk-lamp', name: 'Desk lamp', priceCents: 2990 },
  { id: 'backpack', name: 'Backpack', priceCents: 4900 },
];

export const SHIPPING_CENTS = 490;
export const EXPRESS_SHIPPING_CENTS = 990;
export const FREE_SHIPPING_FROM_CENTS = 5000;
export type Delivery = 'standard' | 'express';

export function findProduct(productId: string, products: Product[] = PRODUCTS): Product {
  const product = products.find((item) => item.id === productId);
  if (!product) throw new Error(`Unknown product: ${productId}`);
  return product;
}

// Correct implementation: each line counts price x quantity.
export function subtotal(lines: CartLine[], products: Product[] = PRODUCTS): number {
  return lines.reduce((sum, line) => sum + findProduct(line.productId, products).priceCents * line.quantity, 0);
}

// Intentional bug to demonstrate independently detecting a regression: the quantity is ignored.
export function subtotalBuggy(lines: CartLine[], products: Product[] = PRODUCTS): number {
  return lines.reduce((sum, line) => sum + findProduct(line.productId, products).priceCents, 0);
}

// An empty cart ships nothing. Standard delivery is free from the threshold on; express never is.
export function shipping(subtotalCents: number, delivery: Delivery = 'standard'): number {
  if (subtotalCents === 0) return 0;
  if (delivery === 'express') return EXPRESS_SHIPPING_CENTS;
  return subtotalCents >= FREE_SHIPPING_FROM_CENTS ? 0 : SHIPPING_CENTS;
}

export function formatPrice(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}

export function addToCart(lines: CartLine[], productId: string): CartLine[] {
  if (lines.some((line) => line.productId === productId)) {
    return lines.map((line) => (line.productId === productId ? { ...line, quantity: line.quantity + 1 } : line));
  }
  return [...lines, { productId, quantity: 1 }];
}

// A quantity that reaches zero removes the line.
export function changeQuantity(lines: CartLine[], productId: string, delta: number): CartLine[] {
  return lines
    .map((line) => (line.productId === productId ? { ...line, quantity: line.quantity + delta } : line))
    .filter((line) => line.quantity > 0);
}
