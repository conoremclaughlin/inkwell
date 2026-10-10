import { describe, expect, it, vi } from 'vitest';
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import { SessionRepository } from './session-repository.js';

// In-memory query only. The native runner's immutable snapshot must preserve
// the attachment column rather than silently treating absent data as false.
describe('native steering attachment evidence', () => {
  it.each([true, false, null, undefined, 'false'])(
    'preserves boolean evidence: %s',
    async (value) => {
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            id: 'synthetic-session',
            user_id: 'synthetic-user',
            agent_id: 'echo',
            cli_attached: value,
            metadata: {},
            started_at: '2026-01-01T00:00:00Z',
          },
          error: null,
        }),
      };
      const repo = new SessionRepository({ from: vi.fn(() => chain) } as never);
      expect((await repo.findById('synthetic-session'))?.cliAttached).toBe(
        typeof value === 'boolean' ? value : undefined
      );
    }
  );
});
