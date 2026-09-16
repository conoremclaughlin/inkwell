import { describe, expect, it, vi } from 'vitest';
import { ThreadKeyTypesRepository, UNKNOWN_TYPE_DEFAULT } from './thread-key-types.repository';

/**
 * Minimal thenable chain: every builder method returns the chain; awaiting it
 * resolves the configured result. `single`/`maybeSingle` resolve it directly.
 */
function chain(result: { data?: unknown; error?: { message: string } | null }) {
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
}

const TEMPLATE_PR = {
  id: 't1',
  user_id: null,
  type: 'pr',
  write_intent: 'write',
  studio_policy: 'provision',
  description: 'template',
  created_at: '',
  updated_at: '',
};
const TEMPLATE_SPEC = {
  id: 't2',
  user_id: null,
  type: 'spec',
  write_intent: 'presence',
  studio_policy: 'reuse-only',
  description: 'template',
  created_at: '',
  updated_at: '',
};
const OVERRIDE_SPEC = {
  id: 'o1',
  user_id: 'user-1',
  type: 'spec',
  write_intent: 'write',
  studio_policy: 'provision',
  description: 'my override',
  created_at: '',
  updated_at: '',
};

function repoWith(rows: unknown[]) {
  const client = { from: vi.fn().mockImplementation(() => chain({ data: rows })) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ThreadKeyTypesRepository(client as any);
}

describe('ThreadKeyTypesRepository.getEffective', () => {
  it('a user override SHADOWS the template for the same type', async () => {
    const repo = repoWith([TEMPLATE_PR, TEMPLATE_SPEC, OVERRIDE_SPEC]);
    const spec = await repo.getEffective('user-1', 'spec');
    expect(spec).toMatchObject({
      writeIntent: 'write',
      studioPolicy: 'provision',
      source: 'override',
    });
  });

  it('falls back to the template when no override exists', async () => {
    const repo = repoWith([TEMPLATE_PR, TEMPLATE_SPEC]);
    const spec = await repo.getEffective('user-1', 'spec');
    expect(spec).toMatchObject({ writeIntent: 'presence', source: 'template' });
  });

  it('unknown types resolve to the conservative default: write + reuse-only', async () => {
    const repo = repoWith([TEMPLATE_PR]);
    const standup = await repo.getEffective('user-1', 'standup');
    expect(standup).toMatchObject({
      type: 'standup',
      writeIntent: 'write',
      studioPolicy: 'reuse-only',
      source: 'default',
    });
  });

  it('a registry READ FAILURE resolves toward write, never presence', async () => {
    // Failing toward presence would let a session mutate an unleased tree —
    // the exact failure the lease exists to prevent. Same fail-closed doctrine
    // as the routing spec's safety predicates.
    const client = {
      from: vi.fn().mockImplementation(() => chain({ error: { message: 'connection refused' } })),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new ThreadKeyTypesRepository(client as any);
    const pr = await repo.getEffective('user-1', 'pr');
    expect(pr.writeIntent).toBe('write');
    expect(pr.source).toBe('default');
  });
});

describe('ThreadKeyTypesRepository.listEffective', () => {
  it('merges templates and overrides, one row per type, overrides win', async () => {
    const repo = repoWith([TEMPLATE_PR, TEMPLATE_SPEC, OVERRIDE_SPEC]);
    const list = await repo.listEffective('user-1');
    expect(list).toHaveLength(2);
    expect(list.find((t) => t.type === 'pr')).toMatchObject({ source: 'template' });
    expect(list.find((t) => t.type === 'spec')).toMatchObject({
      source: 'override',
      writeIntent: 'write',
    });
  });
});

describe('UNKNOWN_TYPE_DEFAULT', () => {
  it('is write + reuse-only (v1 rollout safety — flips to presence when escalation ships)', () => {
    expect(UNKNOWN_TYPE_DEFAULT.writeIntent).toBe('write');
    expect(UNKNOWN_TYPE_DEFAULT.studioPolicy).toBe('reuse-only');
  });
});
