import { describe, expect, it, vi, beforeEach } from 'vitest';
import { handleListThreadKeyTypes, handleSetThreadKeyType } from './thread-key-handlers';

// Real zod schemas stay live (the format test depends on them); only user
// resolution is mocked.
vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveUserOrThrow: vi.fn().mockResolvedValue({ user: { id: 'user-1' }, resolvedBy: 'userId' }),
  };
});

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface TableResults {
  [table: string]: { data?: unknown; error?: { message: string } | null };
}

function composerWith(results: TableResults) {
  const from = vi.fn().mockImplementation((table: string) => {
    const result = results[table] ?? { data: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: Record<string, any> = {};
    for (const m of ['select', 'eq', 'or', 'order', 'delete', 'insert', 'update', 'not']) {
      c[m] = vi.fn().mockReturnValue(c);
    }
    const terminal = () =>
      Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    c.single = vi.fn().mockImplementation(terminal);
    c.maybeSingle = vi.fn().mockImplementation(terminal);
    c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      terminal().then(resolve, reject);
    return c;
  });
  return { composer: { getClient: () => ({ from }) }, from };
}

function parsed(res: { content: Array<{ text: string }> }) {
  return JSON.parse(res.content[0].text);
}

describe('handleSetThreadKeyType', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a type name colliding with one of the user projects slugs', async () => {
    const { composer } = composerWith({
      projects: { data: [{ slug: 'inkread' }] },
    });
    await expect(
      handleSetThreadKeyType(
        { type: 'inkread', writeIntent: 'write', studioPolicy: 'provision' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        composer as any
      )
    ).rejects.toThrow(/collides with your project slug/);
  });

  it('FAILS CLOSED when the slug-collision check itself errors', async () => {
    // "Could not verify no collision" must refuse the write, not allow it —
    // a silently-admitted ambiguous name poisons every future parse.
    const { composer } = composerWith({
      projects: { error: { message: 'db down' } },
    });
    await expect(
      handleSetThreadKeyType(
        { type: 'newtype', writeIntent: 'write', studioPolicy: 'provision' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        composer as any
      )
    ).rejects.toThrow(/Could not verify/);
  });

  it('rejects malformed type names', async () => {
    const { composer } = composerWith({});
    await expect(
      handleSetThreadKeyType(
        { type: 'Bad Name!', writeIntent: 'write', studioPolicy: 'provision' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        composer as any
      )
    ).rejects.toThrow(/Invalid type name/);
  });

  it('requires writeIntent and studioPolicy unless resetting', async () => {
    const { composer } = composerWith({});
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleSetThreadKeyType({ type: 'pr' }, composer as any)
    ).rejects.toThrow(/required unless reset/);
  });

  it('accepts presence overrides (6e gate lifted with the discussion-template flip)', async () => {
    // Discussions execute rather than queue (Conor, 2026-08-24); the public
    // surface matches the templates. Unlocked-edit risk before 6e is a
    // conscious acceptance.
    const { composer, from } = composerWith({
      projects: { data: [] },
      thread_key_types: {
        data: {
          id: 'o2',
          user_id: 'user-1',
          type: 'standup',
          write_intent: 'presence',
          studio_policy: 'reuse-only',
          description: null,
          created_at: '',
          updated_at: '',
        },
      },
    });
    const res = await handleSetThreadKeyType(
      { type: 'standup', writeIntent: 'presence', studioPolicy: 'reuse-only' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      composer as any
    );
    const body = parsed(res);
    expect(body.success).toBe(true);
    expect(body.type).toMatchObject({
      type: 'standup',
      writeIntent: 'presence',
      source: 'override',
    });
    expect(from).toHaveBeenCalledWith('thread_key_types');
  });

  it('upserts a write override when the name is clean', async () => {
    const { composer, from } = composerWith({
      projects: { data: [] },
      thread_key_types: {
        data: {
          id: 'o1',
          user_id: 'user-1',
          type: 'standup',
          write_intent: 'write',
          studio_policy: 'provision',
          description: null,
          created_at: '',
          updated_at: '',
        },
      },
    });
    const res = await handleSetThreadKeyType(
      { type: 'standup', writeIntent: 'write', studioPolicy: 'provision' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      composer as any
    );
    const body = parsed(res);
    expect(body.success).toBe(true);
    expect(body.type).toMatchObject({
      type: 'standup',
      writeIntent: 'write',
      source: 'override',
    });
    expect(from).toHaveBeenCalledWith('thread_key_types');
  });
});

describe('handleListThreadKeyTypes', () => {
  it('returns the effective merged view with the unknown-type default noted', async () => {
    const { composer } = composerWith({
      thread_key_types: {
        data: [
          {
            id: 't1',
            user_id: null,
            type: 'pr',
            write_intent: 'write',
            studio_policy: 'provision',
            description: null,
            created_at: '',
            updated_at: '',
          },
          {
            id: 't2',
            user_id: null,
            type: 'spec',
            write_intent: 'presence',
            studio_policy: 'reuse-only',
            description: null,
            created_at: '',
            updated_at: '',
          },
        ],
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = parsed(await handleListThreadKeyTypes({}, composer as any));
    expect(body.success).toBe(true);
    expect(body.count).toBe(2);
    expect(body.unknownTypeDefault.writeIntent).toBe('write');
  });
});
