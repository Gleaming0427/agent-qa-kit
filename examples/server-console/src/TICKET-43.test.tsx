import { fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';

const clearButton = () => screen.queryByRole('button', { name: 'Clear search' });

describe('TICKET-43 clear the search', () => {
  test('[TICKET-43][AC-1] the Clear search button is displayed only while the search field has text', () => {
    render(<App />);
    const search = screen.getByRole('searchbox', { name: 'Search services' });
    expect(clearButton()).toBeNull();

    fireEvent.change(search, { target: { value: 'alpha' } });
    expect(clearButton()).not.toBeNull();

    fireEvent.change(search, { target: { value: '' } });
    expect(clearButton()).toBeNull();
  });

  test('[TICKET-43][AC-2] clicking Clear search empties the field and lists all services again', () => {
    render(<App />);
    const search = screen.getByRole('searchbox', { name: 'Search services' }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'alpha' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);

    const button = clearButton();
    expect(button).not.toBeNull();
    fireEvent.click(button!);

    expect(search.value).toBe('');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});
