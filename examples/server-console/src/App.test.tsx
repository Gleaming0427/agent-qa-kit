import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';

afterEach(cleanup);
describe('TICKET-42 MFE: services list in an isolated shell', () => {
  test('[TICKET-42][AC-1] MFE lists the user services', () => {
    render(<App />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
  });
  test('[TICKET-42][AC-2] MFE search is case insensitive', () => {
    render(<App />);
    fireEvent.change(screen.getByRole('searchbox', { name: /search services/i }), { target: { value: 'ALPHA' } });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
  });
  test('[TICKET-42][AC-3] MFE shows the empty-state message', () => {
    render(<App />);
    fireEvent.change(screen.getByRole('searchbox', { name: /search services/i }), { target: { value: 'not-found' } });
    expect(screen.getByRole('status')).toHaveTextContent('No service found');
  });
});
