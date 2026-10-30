import { useState } from 'react';
import { SERVICES, filterServices, filterServicesBuggy } from './search';
import './styles.css';

export function App() {
  const [query, setQuery] = useState('');
  const filter = import.meta.env.VITE_DEMO_BUG === '1' ? filterServicesBuggy : filterServices;
  const visible = filter(SERVICES, query);

  return (
    <main className="shell">
      <header><span className="brand">Server Console</span><span className="env">QA sandbox · no real infrastructure</span></header>
      <section aria-labelledby="services-title">
        <h1 id="services-title">Services</h1>
        <p className="subtitle">Manage your example services in a safe, local demo.</p>
        <label htmlFor="search">Search services</label>
        <input id="search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. alpha" />
        <p className="counter" aria-live="polite">{visible.length} service{visible.length === 1 ? '' : 's'} found</p>
        {visible.length ? <ul aria-label="Available services">{visible.map((s) => <li key={s.id}><strong>{s.name}</strong><span>{s.region}</span></li>)}</ul>
          : <p role="status">No service found</p>}
      </section>
      <footer>Local example only. No real API, credentials or external network calls.</footer>
    </main>
  );
}
