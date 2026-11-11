import { useState } from 'react';
import { PRODUCTS, PROMO_CODES, addToCart, changeQuantity, discount, findProduct, formatPrice, shipping, subtotal, subtotalBuggy } from './cart';
import type { CartLine } from './cart';
import './styles.css';

export function App() {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const computeSubtotal = import.meta.env.VITE_DEMO_BUG === '1' ? subtotalBuggy : subtotal;
  const sub = computeSubtotal(lines);
  // Shipping stays on the subtotal before the discount.
  const ship = shipping(sub);
  const [promo, setPromo] = useState('');
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [invalidCode, setInvalidCode] = useState(false);
  const discountCents = appliedCode ? discount(appliedCode, sub) : 0;

  const add = (productId: string) => { setConfirmed(false); setLines((current) => addToCart(current, productId)); };
  const change = (productId: string, delta: number) => setLines((current) => changeQuantity(current, productId, delta));
  const checkout = () => { setLines([]); setConfirmed(true); setAppliedCode(null); setPromo(''); setInvalidCode(false); };
  // An unknown code leaves what was applied before as it is.
  const applyPromo = () => {
    if (PROMO_CODES.has(promo)) { setAppliedCode(promo); setInvalidCode(false); } else { setInvalidCode(true); }
  };

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
          <div className="promo">
            <label htmlFor="promo-code">Promo code</label>
            <div className="promo-row">
              <input id="promo-code" type="text" value={promo} autoComplete="off" onChange={(event) => setPromo(event.target.value)} />
              <button type="button" onClick={applyPromo}>Apply</button>
            </div>
            {invalidCode ? <p role="alert" className="promo-error">Invalid code</p> : null}
          </div>
          <table className="summary" aria-label="Order summary">
            <tbody>
              <tr><th scope="row">Subtotal</th><td>{formatPrice(sub)}</td></tr>
              {discountCents > 0 ? <tr><th scope="row">Discount</th><td>−{formatPrice(discountCents)}</td></tr> : null}
              <tr><th scope="row">Shipping</th><td>{lines.length && ship === 0 ? 'Free' : formatPrice(ship)}</td></tr>
              <tr className="total"><th scope="row">Total</th><td>{formatPrice(sub - discountCents + ship)}</td></tr>
            </tbody>
          </table>
          <button type="button" className="checkout" disabled={!lines.length} onClick={checkout}>Checkout</button>
        </section>
      </div>
      <footer>Local example only. No real payments, accounts or external network calls.</footer>
    </main>
  );
}
