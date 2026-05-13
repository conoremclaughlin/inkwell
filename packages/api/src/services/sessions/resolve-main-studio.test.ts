import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveMainStudio, isMainStudio } from './session-service';

function createChainableMock(terminalResult: unknown) {
  const chain: Record<string, unknown> = {};
  const chainMethods = ['select', 'eq', 'not', 'is', 'neq', 'in', 'order', 'limit', 'insert'];
  for (const m of chainMethods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(terminalResult);
  chain.single = vi.fn().mockResolvedValue(terminalResult);
  return chain;
}

describe('resolveMainStudio', () => {
  const userId = 'user-123';
  const agentId = 'wren';
  const repoRoot = '/Users/test/ws/my-project';

  it('returns existing studio id when found', async () => {
    const existingId = 'studio-uuid-existing';
    const mockSupabase = {
      from: vi
        .fn()
        .mockReturnValue(
          createChainableMock({ data: { id: existingId, updated_at: new Date().toISOString() } })
        ),
    };

    const result = await resolveMainStudio(mockSupabase as never, userId, repoRoot, agentId, {
      autoCreate: true,
    });

    expect(result).toBe(existingId);
    expect(mockSupabase.from).toHaveBeenCalledWith('studios');
  });

  it('auto-creates studio when not found and autoCreate=true', async () => {
    const createdId = 'studio-uuid-new';
    let callCount = 0;
    const mockSupabase = {
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: lookup returns no match
          return createChainableMock({ data: null });
        }
        // Second call: insert returns new studio
        const insertChain = createChainableMock({ data: { id: createdId }, error: null });
        return insertChain;
      }),
    };

    const result = await resolveMainStudio(mockSupabase as never, userId, repoRoot, agentId, {
      autoCreate: true,
    });

    expect(result).toBe(createdId);
    expect(mockSupabase.from).toHaveBeenCalledTimes(2);
  });

  it('returns undefined when not found and autoCreate is false', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue(createChainableMock({ data: null })),
    };

    const result = await resolveMainStudio(mockSupabase as never, userId, repoRoot, agentId);

    expect(result).toBeUndefined();
    expect(mockSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when autoCreate=true but repoRoot is missing', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue(createChainableMock({ data: null })),
    };

    const result = await resolveMainStudio(mockSupabase as never, userId, undefined, agentId, {
      autoCreate: true,
    });

    expect(result).toBeUndefined();
    expect(mockSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when autoCreate=true but agentId is missing', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue(createChainableMock({ data: null })),
    };

    const result = await resolveMainStudio(mockSupabase as never, userId, repoRoot, undefined, {
      autoCreate: true,
    });

    expect(result).toBeUndefined();
    expect(mockSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('handles unique constraint race (23505) with retry', async () => {
    const racedId = 'studio-uuid-raced';
    let callCount = 0;
    const mockSupabase = {
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Lookup: no match
          return createChainableMock({ data: null });
        }
        if (callCount === 2) {
          // Insert: unique constraint violation
          return createChainableMock({
            data: null,
            error: { code: '23505', message: 'duplicate' },
          });
        }
        // Retry lookup: found the concurrently-created row
        return createChainableMock({ data: { id: racedId, updated_at: new Date().toISOString() } });
      }),
    };

    const result = await resolveMainStudio(mockSupabase as never, userId, repoRoot, agentId, {
      autoCreate: true,
    });

    expect(result).toBe(racedId);
    expect(mockSupabase.from).toHaveBeenCalledTimes(3);
  });
});

describe('isMainStudio', () => {
  it('returns true for "main"', () => {
    expect(isMainStudio('main')).toBe(true);
  });

  it('returns false for undefined', () => {
    expect(isMainStudio(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isMainStudio(null)).toBe(false);
  });

  it('returns false for a UUID', () => {
    expect(isMainStudio('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(false);
  });
});
