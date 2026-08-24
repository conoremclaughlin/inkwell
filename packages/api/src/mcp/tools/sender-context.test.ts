/**
 * Bridge classification is a SAFETY predicate, so its failure directions
 * matter more than its happy path.
 *
 * A relay is ambiently "in" its own home repo, never the repo a conversation
 * is about. Getting this wrong routes every bridged thread into the bridge's
 * own worktree, silently. The two outcomes are not symmetric:
 *
 *   treated as bridge   → caller-repo inference skipped → refuse-and-hold,
 *                         which is recoverable and loud
 *   treated as non-bridge → inference runs on the wrong repo → silent misroute
 *
 * So every uncertain case must resolve toward "bridge" (Lumen, PR #514 r2).
 */

import { describe, expect, it, vi } from 'vitest';
import { isBridgeIdentity } from './sender-context';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function client(result: { data?: unknown; error?: { message: string } }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'limit']) {
    chain[m] = vi.fn().mockImplementation((...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    });
  }
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return { supabase: { from: vi.fn().mockReturnValue(chain) }, calls };
}

describe('isBridgeIdentity', () => {
  it('reads the flag from identity metadata', async () => {
    const { supabase } = client({ data: [{ metadata: { bridge: true } }] });
    await expect(isBridgeIdentity(supabase, 'u1', 'myra')).resolves.toBe(true);
  });

  it('is false for an ordinary identity', async () => {
    const { supabase } = client({ data: [{ metadata: {} }] });
    await expect(isBridgeIdentity(supabase, 'u1', 'wren')).resolves.toBe(false);
  });

  it('prefers the canonical UUID over the ambiguous slug', async () => {
    const { supabase, calls } = client({ data: [{ metadata: { bridge: true } }] });
    await isBridgeIdentity(supabase, 'u1', 'myra', 'sb-myra');

    // Keyed by id, never by the slug — the same slug can name different
    // identities in different workspaces, so a slug lookup can read the wrong
    // identity's flag entirely.
    expect(
      calls.some((c) => c.method === 'eq' && c.args[0] === 'id' && c.args[1] === 'sb-myra')
    ).toBe(true);
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'agent_id')).toBe(false);
  });

  it('treats a lookup ERROR as a bridge — the safe direction', async () => {
    // Previously returned false here, which is the dangerous direction: an
    // unreadable identity would enable inference rather than skip it.
    const { supabase } = client({ error: { message: 'connection reset' } });
    await expect(isBridgeIdentity(supabase, 'u1', 'myra')).resolves.toBe(true);
  });

  it('treats an ambiguous slug as a bridge rather than picking one', async () => {
    const { supabase } = client({
      data: [{ metadata: { bridge: true } }, { metadata: {} }],
    });
    await expect(isBridgeIdentity(supabase, 'u1', 'myra')).resolves.toBe(true);
  });

  it('does not treat ambiguity as a bridge when the canonical UUID pins it', async () => {
    const { supabase } = client({ data: [{ metadata: {} }] });
    await expect(isBridgeIdentity(supabase, 'u1', 'wren', 'sb-wren')).resolves.toBe(false);
  });

  it('never throws — a classification failure must not take down the send', async () => {
    const exploding = {
      from: vi.fn().mockImplementation(() => {
        throw new Error('boom');
      }),
    };
    await expect(isBridgeIdentity(exploding, 'u1', 'myra')).resolves.toBe(true);
  });

  it('is false with no identifier at all (nothing to classify)', async () => {
    const { supabase } = client({ data: [] });
    await expect(isBridgeIdentity(supabase, 'u1', null)).resolves.toBe(false);
  });
});
