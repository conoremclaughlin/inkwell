/**
 * The name a caller reads is the name the router matches on (routing spec
 * §v19 C).
 *
 * `recipientStudioSlug` on send_to_inbox and `studioHint` on trigger_agent
 * resolve against `studios.slug`. The read tools used to return only
 * `worktreeFolder`, the basename of the worktree path, and the two differ for
 * roughly half of all studios (slug `wren-cli`, folder
 * `personal-context-protocol--wren-cli`). A caller who read list_studios and
 * passed the name it showed addressed a studio that does not exist.
 *
 * So these tests pin the two sides against each other rather than pinning a
 * field's presence: whatever list_studios and get_studio report as `slug`
 * must resolve through `resolveStudioHint` to that same studio, and the
 * folder name must not.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('../../config/env', async () => ({
  env: { ...(await import('../../test/fake-env')).fakeEnv },
  isDevelopment: () => false,
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const USER = '00000000-0000-0000-0000-000000000001';

vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/user-resolver')>();
  return { ...actual, resolveUserOrThrow: vi.fn(async () => ({ user: { id: USER } })) };
});

import { handleGetStudio, handleListStudios, handleUpdateStudio } from './studio-handlers';
import { resolveStudioHint } from '../../services/sessions';
import type { DataComposer } from '../../data/composer';

const STUDIO_ID = '11111111-1111-4111-8111-111111111111';

/** A studio whose slug and folder differ, as 144 of 243 did when measured. */
const studio = {
  id: STUDIO_ID,
  userId: USER,
  sbSlug: 'wren',
  slug: 'wren-cli',
  worktreePath: '/ws/pcp/personal-context-protocol--wren-cli',
  repoRoot: '/ws/pcp/personal-context-protocol',
  branch: 'wren/feat/cli',
  status: 'active',
  purpose: null,
  lease: null,
  ephemeral: false,
  createdAt: '2026-09-29T00:00:00Z',
};

/** A legacy row with no slug: the field is reported as null, never dropped. */
const legacy = {
  ...studio,
  id: '22222222-2222-4222-8222-222222222222',
  slug: null,
  worktreePath: '/ws/pcp/personal-context-protocol--old',
};

function composer(rows: Array<typeof studio | typeof legacy>) {
  const byId = (id: string) => rows.find((r) => r.id === id) ?? null;
  return {
    getClient: () => ({}),
    repositories: {
      studios: {
        listByUser: vi.fn(async () => rows),
        findById: vi.fn(async (id: string) => byId(id)),
        update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
          ...byId(id),
          ...patch,
        })),
      },
    },
  } as unknown as DataComposer;
}

/**
 * The studios table as resolveStudioHint queries it. Every filter is applied
 * for real — a fake that ignored `.eq('slug', …)` would resolve any string,
 * and the folder-name control below would pass for the wrong reason.
 */
function studiosTable(rows: Array<Record<string, unknown>>) {
  // resolveStudioHint queries the DB columns; map the model onto them.
  const table = rows.map((r) => ({
    id: r.id,
    user_id: r.userId,
    agent_id: r.sbSlug,
    slug: r.slug,
    status: r.status,
  }));
  return {
    from(name: string) {
      expect(name).toBe('studios');
      let working = [...table];
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          working = working.filter((row) => (row as Record<string, unknown>)[column] === value);
          return chain;
        },
        in: (column: string, values: unknown[]) => {
          working = working.filter((row) =>
            values.includes((row as Record<string, unknown>)[column])
          );
          return chain;
        },
        limit: (n: number) => {
          working = working.slice(0, n);
          return chain;
        },
        maybeSingle: async () => ({ data: working[0] ?? null, error: null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

describe('the studio name the read tools report is the name the router resolves', () => {
  it('list_studios: slug resolves to the studio; the folder name resolves to nothing', async () => {
    const listed = parse(await handleListStudios({ sbSlug: 'wren' }, composer([studio, legacy])));
    const row = listed.studios.find((s: { id: string }) => s.id === STUDIO_ID);

    expect(row.slug).toBe('wren-cli');
    expect(row.worktreeFolder).toBe('personal-context-protocol--wren-cli');

    const table = studiosTable([studio]);
    await expect(resolveStudioHint(table, USER, row.slug, 'wren')).resolves.toBe(STUDIO_ID);
    // Control: the name callers used to read. Without this, a fake that
    // matched anything would make the line above meaningless.
    await expect(resolveStudioHint(table, USER, row.worktreeFolder, 'wren')).resolves.toBe(
      undefined
    );
  });

  it('get_studio: slug resolves to the studio', async () => {
    const got = parse(await handleGetStudio({ studioId: STUDIO_ID }, composer([studio])));

    expect(got.studio.slug).toBe('wren-cli');
    await expect(
      resolveStudioHint(studiosTable([studio]), USER, got.studio.slug, 'wren')
    ).resolves.toBe(STUDIO_ID);
  });

  it('update_studio: the response carries the slug too', async () => {
    const updated = parse(
      await handleUpdateStudio(
        { sbSlug: 'wren', studioId: STUDIO_ID, purpose: 'cli work' },
        composer([studio])
      )
    );

    expect(updated.studio.slug).toBe('wren-cli');
  });

  it('a studio with no slug reports null, so a reader can tell it is not addressable by name', async () => {
    const listed = parse(await handleListStudios({ sbSlug: 'wren' }, composer([legacy])));
    const got = parse(await handleGetStudio({ studioId: legacy.id }, composer([legacy])));

    expect(listed.studios[0]).toHaveProperty('slug', null);
    expect(got.studio).toHaveProperty('slug', null);
  });
});
