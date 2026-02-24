import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAgentFromMention } from './resolve-mention';

// Mock Supabase client
function createMockSupabase(identities: Array<{ id: string; agent_id: string; name: string | null }>) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          data: identities,
          error: null,
        }),
      }),
    }),
  } as any;
}

function createErrorSupabase() {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          data: null,
          error: { message: 'DB error' },
        }),
      }),
    }),
  } as any;
}

const TEST_IDENTITIES = [
  { id: 'id-wren', agent_id: 'wren', name: 'Wren' },
  { id: 'id-myra', agent_id: 'myra', name: 'Myra' },
  { id: 'id-benson', agent_id: 'benson', name: 'Benson' },
];

describe('resolveAgentFromMention', () => {
  it('matches by mentioned username against agent_id', async () => {
    const supabase = createMockSupabase(TEST_IDENTITIES);
    const result = await resolveAgentFromMention(supabase, 'user-1', 'hello', ['wren']);
    expect(result).toEqual({ agentId: 'wren', identityId: 'id-wren' });
  });

  it('matches by mentioned username against name', async () => {
    const supabase = createMockSupabase(TEST_IDENTITIES);
    const result = await resolveAgentFromMention(supabase, 'user-1', 'hello', ['Myra']);
    expect(result).toEqual({ agentId: 'myra', identityId: 'id-myra' });
  });

  it('matches case-insensitively', async () => {
    const supabase = createMockSupabase(TEST_IDENTITIES);
    const result = await resolveAgentFromMention(supabase, 'user-1', 'hello', ['BENSON']);
    expect(result).toEqual({ agentId: 'benson', identityId: 'id-benson' });
  });

  it('matches by text mention when no username match', async () => {
    const supabase = createMockSupabase(TEST_IDENTITIES);
    const result = await resolveAgentFromMention(supabase, 'user-1', 'hey wren, can you help?', []);
    expect(result).toEqual({ agentId: 'wren', identityId: 'id-wren' });
  });

  it('uses word boundaries for text matching', async () => {
    const supabase = createMockSupabase(TEST_IDENTITIES);
    // "wrench" should NOT match "wren"
    const result = await resolveAgentFromMention(supabase, 'user-1', 'pass me the wrench', []);
    expect(result).toBeNull();
  });

  it('returns null when no mention matches', async () => {
    const supabase = createMockSupabase(TEST_IDENTITIES);
    const result = await resolveAgentFromMention(supabase, 'user-1', 'hello world', ['someuser']);
    expect(result).toBeNull();
  });

  it('returns null when no identities exist', async () => {
    const supabase = createMockSupabase([]);
    const result = await resolveAgentFromMention(supabase, 'user-1', 'hey wren', ['wren']);
    expect(result).toBeNull();
  });

  it('returns null on DB error', async () => {
    const supabase = createErrorSupabase();
    const result = await resolveAgentFromMention(supabase, 'user-1', 'hey wren', ['wren']);
    expect(result).toBeNull();
  });

  it('prioritizes mentioned username over text match', async () => {
    const supabase = createMockSupabase(TEST_IDENTITIES);
    // Mentions say "myra" but text says "wren" — mention should win
    const result = await resolveAgentFromMention(supabase, 'user-1', 'wren should help', ['myra']);
    expect(result).toEqual({ agentId: 'myra', identityId: 'id-myra' });
  });

  it('matches text with agent name (identity name, not agent_id)', async () => {
    const supabase = createMockSupabase([
      { id: 'id-custom', agent_id: 'custom-agent', name: 'Nova' },
    ]);
    const result = await resolveAgentFromMention(supabase, 'user-1', 'hey Nova!', []);
    expect(result).toEqual({ agentId: 'custom-agent', identityId: 'id-custom' });
  });
});
