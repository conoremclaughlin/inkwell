// @vitest-environment jsdom
/**
 * Counts of what the skills page actually renders.
 *
 * This exists because of a specific mistake. While fixing the 390px clipping I
 * edited the file with a script that sliced it between two markers, and the end
 * marker resolved EARLIER in the file than the start marker. The slice came back
 * empty, and re-joining the pieces emitted the region between them a second
 * time — so the page shipped with the entire Filters card duplicated, two
 * search inputs bound to the same state.
 *
 * Nothing I ran caught it. Type-check passes on duplicated JSX. Prettier
 * formats it happily. The overflow probe measures per-element widths, which a
 * duplicate does not change. The script printed "0 replacements" and I read
 * that as a harmless no-op instead of looking at what it had written. Lumen
 * found it by reading the diff.
 *
 * So: assert the counts, not the classes. A structural regression is invisible
 * to every check that looks at one element at a time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const useApiQuery = vi.fn();
vi.mock('@/lib/api', () => ({
  useApiQuery: (...args: unknown[]) => useApiQuery(...args),
  apiPost: vi.fn(),
}));

const SkillsPage = (await import('./page')).default;

const SKILL = {
  name: 'example-skill',
  displayName: 'Example Skill',
  description: 'A fixture, not a real skill.',
  type: 'guide' as const,
  category: 'custom',
  version: '0.1.0',
  // Must be a real SkillStatus. 'active' is not one, and an invalid value
  // here crashes the render on statusConfig[skill.status].icon — which
  // type-check does NOT catch, because it excludes *.test.tsx.
  status: 'available' as const,
  eligibility: { eligible: true },
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SkillsPage />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  useApiQuery.mockReturnValue({
    data: { skills: [SKILL], categories: ['custom'], totalCount: 1 },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
});

afterEach(cleanup);

describe('skills page structure', () => {
  it('renders exactly one search box', () => {
    // Two of these is the duplication bug: both bind to the same searchQuery
    // state, so typing in one silently drives the other.
    renderPage();
    expect(screen.getAllByPlaceholderText('Search skills...')).toHaveLength(1);
  });

  it('renders exactly one set of type filters', () => {
    renderPage();
    for (const label of ['All', 'Mini App', 'CLI Tool', 'Guide']) {
      expect(screen.getAllByRole('button', { name: label }), label).toHaveLength(1);
    }
  });

  it('renders exactly one header action of each kind', () => {
    renderPage();
    expect(screen.getAllByRole('button', { name: /Refresh/i })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: /Browse Registry/i })).toHaveLength(1);
  });

  it('renders exactly one stats row — four cards, no repeats', () => {
    renderPage();
    for (const label of ['Total Skills', 'Available', 'Need Setup', 'Categories']) {
      expect(screen.getAllByText(label), label).toHaveLength(1);
    }
  });

  it('renders each skill once', () => {
    useApiQuery.mockReturnValue({
      data: {
        skills: [SKILL, { ...SKILL, name: 'second', displayName: 'Second Skill' }],
        categories: ['custom'],
        totalCount: 2,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getAllByText('Example Skill')).toHaveLength(1);
    expect(screen.getAllByText('Second Skill')).toHaveLength(1);
  });

  it('renders one heading', () => {
    renderPage();
    expect(screen.getAllByRole('heading', { name: 'Skills & Mini Apps' })).toHaveLength(1);
  });
});
