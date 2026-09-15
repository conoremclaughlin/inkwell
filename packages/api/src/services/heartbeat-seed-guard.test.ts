/**
 * ensureDefaultReminders fails CLOSED when its identity lookup errors.
 *
 * Supabase reports a failed read as a fulfilled `{ data: null, error }`, not a
 * rejection. The shared heartbeat test builder cannot express that shape, so
 * this file mocks the client directly (after Lumen's PR #595 repro). A
 * duplicate default reminder reports to no one, so "could not look" must
 * never become "nothing there".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = { identityError: false, inserts: [] as Array<{ table: string; row: unknown }> };

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of [
    'select',
    'eq',
    'in',
    'filter',
    'limit',
    'order',
    'insert',
    'update',
    'single',
  ]) {
    b[m] = vi.fn((...args: unknown[]) => {
      if (m === 'insert') state.inserts.push({ table, row: args[0] });
      return b;
    });
  }
  b.then = (resolve: (v: unknown) => void) => {
    let result: unknown;
    if (table === 'agent_identities') {
      result = state.identityError
        ? { data: null, error: { code: '08006', message: 'transient identity lookup failure' } }
        : { data: [{ id: 'sb-new', workspace_id: 'ws-1' }], error: null };
    } else if (table === 'users') {
      result = { data: { timezone: 'UTC' }, error: null };
    } else {
      const wrote = state.inserts.some((i) => i.table === 'scheduled_reminders');
      result = { data: wrote ? { id: 'rem-new' } : [], error: null };
    }
    resolve(result);
    return Promise.resolve(result);
  };
  return b;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: (table: string) => builder(table) })),
}));
vi.mock('../config/env.js', async () => ({
  env: { ...(await import('../test/fake-env')).fakeEnv },
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureDefaultReminders } from './heartbeat';
import { logger } from '../utils/logger';

const params = {
  userId: 'user-1',
  sbId: 'sb-new',
  sbSlug: 'myra',
  deliveryChannel: 'telegram',
  deliveryTarget: '123',
};

describe('ensureDefaultReminders — candidate lookup failure (PR #595, Lumen)', () => {
  beforeEach(() => {
    state.identityError = false;
    state.inserts = [];
    vi.clearAllMocks();
  });

  it('does not seed when the identity lookup errors — it warns and skips', async () => {
    state.identityError = true;
    await ensureDefaultReminders(params);
    expect(state.inserts).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('identity lookup failed'),
      expect.objectContaining({ sbSlug: 'myra', sbId: 'sb-new' })
    );
  });

  it('seeds normally when the lookup succeeds and no check-in exists', async () => {
    await ensureDefaultReminders(params);
    expect(state.inserts.some((i) => i.table === 'scheduled_reminders')).toBe(true);
  });
});
