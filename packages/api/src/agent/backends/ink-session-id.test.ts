import { describe, expect, it, vi } from 'vitest';
vi.mock('@anthropic-ai/sdk', () => ({ default: class FakeAnthropic {} }));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
import { InkBackend } from './ink.backend';

describe('Ink session identifiers', () => {
  it('uses a cryptographic UUID without consulting Math.random', async () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Weak random source');
    });
    try {
      const backend = new InkBackend({ apiKey: 'synthetic-api-key' });
      await backend.initialize();
      expect(backend.getSessionId()).toMatch(
        /^ink-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
      );
    } finally {
      random.mockRestore();
    }
  });
});
