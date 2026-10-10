// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  useApiQuery: query,
  useWorkspaceApiQuery: query,
  useApiPost: () => ({ mutate: vi.fn() }),
  useApiPut: () => ({ mutate: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  apiPost: vi.fn(),
}));
import LibraryPage from '@/app/(dashboard)/artifacts/page';
import { setSelectedWorkspaceId } from '@/lib/workspace-selection';
import TasksPage from '@/app/(dashboard)/tasks/page';
const task = {
  id: 'fixture-task',
  title: 'Garden task',
  description: 'Paper trail',
  status: 'completed',
  priority: 'medium',
  tags: [],
  taskGroupId: null,
  createdAt: '2026-01-01T00:00:00Z',
};
const artifact = {
  id: 'fixture-doc',
  title: 'Garden plan',
  uri: 'ink://specs/garden',
  artifactType: 'spec',
  visibility: 'private',
  editMode: 'workspace',
  version: 1,
  tags: [],
  updatedAt: '2026-01-01T00:00:00Z',
};
beforeEach(() => {
  vi.useFakeTimers();
  query.mockReset();
});
afterEach(() => {
  cleanup();
  setSelectedWorkspaceId(null);
  vi.useRealTimers();
});
for (const [kind, Component, label] of [
  ['tasks', TasksPage, 'Search tasks'],
  ['artifacts', LibraryPage, 'Search Library'],
] as const) {
  describe(`${kind} backend search page`, () => {
    function setup(
      options: { error?: boolean; truncated?: boolean; empty?: boolean; loading?: boolean } = {}
    ) {
      query.mockImplementation((key: unknown[]) =>
        key[0] !== kind
          ? { data: undefined }
          : {
              data:
                options.error || options.empty
                  ? undefined
                  : {
                      tasks: [task],
                      artifacts: [artifact],
                      meta: {
                        fetched: 1,
                        total: options.truncated ? 1001 : 1,
                        truncated: options.truncated ?? false,
                      },
                    },
              isLoading: options.loading ?? false,
              error: options.error ? new Error('Synthetic read failed') : null,
            }
      );
      return render(<Component />);
    }
    it('keys the encoded backend request by query and shows completed matches', () => {
      setup();
      fireEvent.change(screen.getByRole('searchbox', { name: label }), {
        target: { value: 'garden & paper' },
      });
      expect(screen.getByText('Searching…')).toBeTruthy();
      act(() => vi.advanceTimersByTime(250));
      expect(query).toHaveBeenCalledWith(
        [kind, { search: 'garden & paper' }],
        `/api/admin/${kind}?search=garden%20%26%20paper`,
        ...(kind === 'tasks' ? [{ refetchInterval: 30000 }] : [null])
      );
      expect(screen.getByText(kind === 'tasks' ? 'Garden task' : 'Garden plan')).toBeTruthy();
      query.mockClear();
      fireEvent.click(screen.getByRole('button', { name: `Clear ${label.toLowerCase()}` }));
      expect(query.mock.calls.find(([key]) => key[0] === kind)?.[1]).toBe(`/api/admin/${kind}`);
    });
    it('quotes a no-match query without rendering the first-use empty message', () => {
      setup({ empty: true });
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'quartz' } });
      act(() => vi.advanceTimersByTime(250));
      expect(screen.getByText(new RegExp('No .*match “quartz”'))).toBeTruthy();
      expect(screen.queryByText(/create_artifact|create_task/)).toBeNull();
    });
    it('does not claim zero matches after a failed read', () => {
      setup({ error: true });
      expect(screen.getByRole('alert').textContent).toBe('Synthetic read failed');
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByText(/No tasks yet|Library is empty/)).toBeNull();
    });
    it('reports the display cap rather than silently treating it as the whole search', () => {
      setup({ truncated: true });
      expect(screen.getByRole('status').textContent).toContain('1001');
      expect(screen.getByRole('status').textContent).toContain('Narrow your search');
    });
  });
}

it('binds Library search requests to a changed workspace, not just the query text', () => {
  query.mockReturnValue({ data: { artifacts: [] }, isLoading: false, error: null });
  setSelectedWorkspaceId('fixture-workspace-a');
  render(<LibraryPage />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'garden' } });
  act(() => vi.advanceTimersByTime(250));
  expect(query).toHaveBeenLastCalledWith(
    ['artifacts', { search: 'garden' }],
    '/api/admin/artifacts?search=garden',
    'fixture-workspace-a'
  );
  act(() => setSelectedWorkspaceId('fixture-workspace-b'));
  expect(query).toHaveBeenLastCalledWith(
    ['artifacts', { search: 'garden' }],
    '/api/admin/artifacts?search=garden',
    'fixture-workspace-b'
  );
});

it('does not claim a status-filtered search is empty when the result set is capped', () => {
  query.mockImplementation((key: unknown[]) =>
    key[0] === 'tasks'
      ? {
          data: { tasks: [task], meta: { fetched: 1, total: 1001, truncated: true } },
          isLoading: false,
          error: null,
        }
      : {}
  );
  render(<TasksPage />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'garden' } });
  act(() => vi.advanceTimersByTime(250));
  fireEvent.click(screen.getByRole('button', { name: 'Blocked' }));
  expect(screen.getByText(/No tasks in the loaded results for this view/)).toBeTruthy();
  expect(screen.queryByText(/No tasks match/)).toBeNull();
});
