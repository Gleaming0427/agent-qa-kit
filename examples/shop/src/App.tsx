import { useState } from 'react';
import { PRODUCTS, addToCart, changeQuantity, findProduct, formatPrice, shipping, subtotal, subtotalBuggy } from './cart';
import type { CartLine } from './cart';
import './styles.css';

export function App() {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const computeSubtotal = import.meta.env.VITE_DEMO_BUG === '1' ? subtotalBuggy : subtotal;
  const sub = computeSubtotal(lines);
  const ship = shipping(sub);

  const add = (productId: string) => { setConfirmed(false); setLines((current) => addToCart(current, productId)); };
  const change = (productId: string, delta: number) => setLines((current) => changeQuantity(current, productId, delta));
  const checkout = () => { setLines([]); setConfirmed(true); };

  return (
    <main className="shell">
      <header><span className="brand">Demo Shop</span><span className="env">QA sandbox · no real payments</span></header>
      <div className="layout">
        <section aria-labelledby="shop-title">
          <h1 id="shop-title">Shop</h1>
          <p className="subtitle">Pick a few items and check out in a safe, local demo.</p>
          <ul className="products" aria-label="Products">
            {PRODUCTS.map((p) => (
              <li key={p.id}>
                <strong>{p.name}</strong>
                <span className="price">{formatPrice(p.priceCents)}</span>
                <button type="button" aria-label={`Add ${p.name} to cart`} onClick={() => add(p.id)}>Add to cart</button>
              </li>
            ))}
          </ul>
        </section>
        <section className="cart" aria-labelledby="cart-title">
          <h2 id="cart-title">Cart</h2>
          {confirmed ? <p role="status" className="confirmed">Order confirmed</p> : null}
          {lines.length ? (
            <ul className="lines" aria-label="Cart items">
              {lines.map((line) => {
                const product = findProduct(line.productId);
                return (
                  <li key={line.productId}>
                    <span className="line-name">{product.name}</span>
                    <span className="qty">
                      <button type="button" aria-label={`Decrease ${product.name} quantity`} onClick={() => change(line.productId, -1)}>−</button>
                      <span>× {line.quantity}</span>
                      <button type="button" aria-label={`Increase ${product.name} quantity`} onClick={() => change(line.productId, 1)}>+</button>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="empty">Your cart is empty</p>}
          <table className="summary" aria-label="Order summary">
            <tbody>
              <tr><th scope="row">Subtotal</th><td>{formatPrice(sub)}</td></tr>
              <tr><th scope="row">Shipping</th><td>{lines.length && ship === 0 ? 'Free' : formatPrice(ship)}</td></tr>
              <tr className="total"><th scope="row">Total</th><td>{formatPrice(sub + ship)}</td></tr>
            </tbody>
          </table>
          <button type="button" className="checkout" disabled={!lines.length} onClick={checkout}>Checkout</button>
        </section>
      </div>
      <footer>Local example only. No real payments, accounts or external network calls.</footer>
    </main>
  );
}
