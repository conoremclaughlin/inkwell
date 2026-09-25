// @vitest-environment jsdom
/**
 * The tasks page, rendered with data the server can actually send.
 *
 * task-display.test.ts covers the resolvers in isolation and was green while
 * the page still had two ways to die on the same input. Both were found by
 * putting an unrecognised status in a synthetic fixture and LOOKING at the
 * result, not by reading the file:
 *
 *   1. `groups[task.status].push(task)` — a grouping lookup, not a style
 *      lookup, so the audit grep I ran (names ending Config/COLORS) never had
 *      it in the population. Undefined key, `.push` throws, page gone.
 *   2. the column list was a fixed array of the four known statuses, so a task
 *      with any other status was grouped and then never rendered — present in
 *      the data, absent from the board, nothing reporting it.
 *
 * So these tests render the page with a foreign priority AND a foreign status
 * and assert both that it survives and that nothing disappears.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const useApiQuery = vi.fn();
vi.mock('@/lib/api', () => ({
  useApiQuery: (...args: unknown[]) => useApiQuery(...args),
  useApiPost: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useApiPut: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  apiPost: vi.fn(),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));

const TasksPage = (await import('./page')).default;

const task = (over: Partial<Record<string, unknown>> = {}) => ({
  id: crypto.randomUUID(),
  title: 'Fixture task',
  description: null,
  status: 'pending',
  priority: 'medium',
  tags: [],
  projectId: null,
  projectName: null,
  taskGroupId: null,
  taskGroupTitle: null,
  blockedBy: null,
  createdBy: 'wren',
  completedAt: null,
  dueDate: null,
  metadata: {},
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  ...over,
});

function renderWith(tasks: unknown[]) {
  useApiQuery.mockImplementation((key: unknown) => {
    // The page makes several queries; only the tasks one is stubbed with data.
    if (Array.isArray(key) && key[0] === 'tasks') {
      return {
        data: {
          tasks,
          stats: { total: tasks.length, pending: 0, inProgress: 0, completed: 0, blocked: 0 },
        },
        isLoading: false,
        error: null,
      };
    }
    return { data: undefined, isLoading: false, error: null };
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TasksPage />
    </QueryClientProvider>
  );
}

afterEach(cleanup);
beforeEach(() => useApiQuery.mockReset());

describe('tasks page with values outside the declared unions', () => {
  it('renders a task whose priority is from the other vocabulary', () => {
    // 'normal' is the task_groups default and sits on two live rows. This is
    // the crash that started all of it.
    renderWith([task({ title: 'Foreign priority', priority: 'normal' })]);
    expect(screen.getByText('Foreign priority')).toBeTruthy();
    expect(screen.getAllByText('normal').length).toBeGreaterThan(0);
  });

  it('renders a task whose STATUS is outside the union', () => {
    renderWith([task({ title: 'Foreign status', status: 'cancelled' })]);
    expect(screen.getByText('Foreign status')).toBeTruthy();
  });

  it('does not silently drop a task with an unrecognised status', () => {
    // The grouping used to put it in a bucket the column list never read.
    // Present in the data, absent from the board.
    renderWith([
      task({ title: 'Known status task', status: 'pending' }),
      task({ title: 'Unknown status task', status: 'archived' }),
    ]);
    expect(screen.getByText('Known status task')).toBeTruthy();
    expect(screen.getByText('Unknown status task'), 'a task vanished from the board').toBeTruthy();
  });

  it('survives every combination of foreign status and priority at once', () => {
    renderWith([
      task({ title: 'A', status: 'cancelled', priority: 'normal' }),
      task({ title: 'B', status: 'archived', priority: 'urgent' }),
      task({ title: 'C', status: 'deferred', priority: null }),
      task({ title: 'D', status: 'constructor', priority: 'constructor' }),
      // __proto__ is the one that hides rather than throws: assigning it on an
      // ordinary object invokes the inherited setter, so hasOwnProperty stays
      // false, Object.keys never sees the bucket, and each task silently
      // replaces the last. Two of them, so a bucket that swallows one would
      // still lose the other.
      task({ title: 'E', status: '__proto__', priority: '__proto__' }),
      task({ title: 'F', status: '__proto__', priority: 'low' }),
    ]);
    for (const title of ['A', 'B', 'C', 'D', 'E', 'F']) {
      expect(screen.getByText(title), title).toBeTruthy();
    }
  });

  it('still renders ordinary tasks', () => {
    renderWith([task({ title: 'Ordinary', status: 'in_progress', priority: 'high' })]);
    expect(screen.getByText('Ordinary')).toBeTruthy();
    expect(screen.getAllByText('High').length).toBeGreaterThan(0);
  });
});
