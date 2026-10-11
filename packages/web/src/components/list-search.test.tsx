// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ListSearch, useListSearch } from './list-search';
function Harness() {
  const search = useListSearch();
  return (
    <>
      <ListSearch
        label="Search tasks"
        hint="Titles and descriptions"
        value={search.value}
        onChange={search.setValue}
      />
      <output data-testid="query">{search.query}</output>
      <output data-testid="pending">{String(search.pending)}</output>
    </>
  );
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('list search control', () => {
  it('debounces the final normalized query and cancels earlier timers', () => {
    render(<Harness />);
    const input = screen.getByRole('searchbox', { name: 'Search tasks' });
    fireEvent.change(input, { target: { value: 'garden' } });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.change(input, { target: { value: '  garden   paper ' } });
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByTestId('query').textContent).toBe('');
    expect(screen.getByTestId('pending').textContent).toBe('true');
    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByTestId('query').textContent).toBe('garden paper');
    expect(screen.getByTestId('pending').textContent).toBe('false');
  });
  it('clears immediately, refocuses, and does not revive a pending query', () => {
    render(<Harness />);
    const input = screen.getByRole('searchbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'garden' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search tasks' }));
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId('query').textContent).toBe('');
  });
});
