import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pollReaderRefusal, presenceRefused } from './poll-gate';
import { INKLING_CLIENT } from './inkling-client';

/**
 * The real gate over a real classification (classifyIdentityById), with only
 * the identity row faked: what agent_identities answers for one id.
 */
function client(answer: { data: unknown; error: unknown }): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => answer,
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

const row = (metadata: unknown) => ({
  data: { id: 'sb-1', user_id: 'user-1', metadata },
  error: null,
});
const INKLING = row({ client: INKLING_CLIENT, named: false, ownerTest: true });
const ORDINARY = row({ role: 'developer' });
const ORDINARY_NO_METADATA = row(null);
const MISSING = { data: null, error: null };
const READ_FAILED = { data: null, error: { message: 'connection refused' } };

describe('pollReaderRefusal: a polling client never reads as an inkling, and fails closed', () => {
  it('refuses an inkling', async () => {
    expect(await pollReaderRefusal(client(INKLING), 'sb-1')).toBe(
      "an inkling's mail is never delivered to a polling client"
    );
  });

  it('lets an ordinary SB read, metadata or none', async () => {
    expect(await pollReaderRefusal(client(ORDINARY), 'sb-1')).toBeNull();
    expect(await pollReaderRefusal(client(ORDINARY_NO_METADATA), 'sb-1')).toBeNull();
  });

  it('refuses an identity that cannot be read, or is gone, or a session with none', async () => {
    expect(await pollReaderRefusal(client(READ_FAILED), 'sb-1')).toBe(
      'session identity could not be classified'
    );
    expect(await pollReaderRefusal(client(MISSING), 'sb-1')).toBe(
      'session identity could not be classified'
    );
    expect(await pollReaderRefusal(client(ORDINARY), null)).toBe(
      'session has no canonical identity'
    );
  });
});

describe('presenceRefused: an inkling session is never marked attached or polling', () => {
  it('refuses only a positively identified inkling', async () => {
    expect(await presenceRefused(client(INKLING), 'sb-1')).toBe(true);
    expect(await presenceRefused(client(ORDINARY), 'sb-1')).toBe(false);
    expect(await presenceRefused(client(ORDINARY_NO_METADATA), 'sb-1')).toBe(false);
  });

  it("doesn't refuse on a read it couldn't make, or with no identity: the read gate covers those", async () => {
    expect(await presenceRefused(client(READ_FAILED), 'sb-1')).toBe(false);
    expect(await presenceRefused(client(MISSING), 'sb-1')).toBe(false);
    expect(await presenceRefused(client(ORDINARY), undefined)).toBe(false);
  });
});
