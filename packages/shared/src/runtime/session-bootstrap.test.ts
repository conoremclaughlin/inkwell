import { describe, expect, it, vi } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import { bootstrapSessionIdentity, type SessionBootstrapPorts } from './session-bootstrap.js';

function harness() {
  const order: string[] = [];
  const result = {
    identityFiles: { soul: 'A synthetic identity.' },
    user: { timezone: 'America/Los_Angeles' },
    memoryIds: ['memory-a'],
    reflectionStatus: { suggestion: 'Consider reflecting.' },
  };
  const ports: SessionBootstrapPorts = {
    load: vi.fn(async () => {
      order.push('load');
      return result;
    }),
    ledger: new ContextLedger(),
    setTimezone: vi.fn(() => {
      order.push('timezone');
    }),
    setContext: vi.fn(() => {
      order.push('context');
    }),
    seedMemoryIds: vi.fn(() => {
      order.push('seed');
    }),
    prepareHost: vi.fn(async () => {
      order.push('host');
    }),
    unavailable: vi.fn(),
  };
  return { ports, order, result };
}

describe('shared session bootstrap', () => {
  it('keeps identity application, host preparation, dedup and marker ordering', async () => {
    const h = harness();
    vi.mocked(h.ports.prepareHost).mockImplementation(async () => {
      h.order.push('host');
      expect(h.ports.seedMemoryIds).not.toHaveBeenCalled();
      expect(h.ports.ledger.listEntries()).toEqual([]);
    });
    await bootstrapSessionIdentity({ sbSlug: 'echo' }, h.ports);
    expect(h.order).toEqual(['load', 'timezone', 'context', 'host', 'seed']);
    expect(h.ports.load).toHaveBeenCalledWith('echo');
    expect(h.ports.setContext).toHaveBeenCalledWith('--- SOUL.md ---\nA synthetic identity.');
    expect(h.ports.setTimezone).toHaveBeenCalledWith('America/Los_Angeles');
    expect(h.ports.seedMemoryIds).toHaveBeenCalledWith(['memory-a']);
    expect(h.ports.ledger.listEntries()).toEqual([
      expect.objectContaining({
        role: 'system',
        source: 'bootstrap',
        content: 'Bootstrapped as echo (America/Los_Angeles). Consider reflecting.',
      }),
    ]);
  });

  it('caller identity skips bootstrap and seeding but still prepares the host', async () => {
    const h = harness();
    await bootstrapSessionIdentity(
      { sbSlug: 'nascent', systemPromptOverride: 'Choose a name.' },
      h.ports
    );
    expect(h.order).toEqual(['host']);
    expect(h.ports.load).not.toHaveBeenCalled();
    expect(h.ports.ledger.listEntries()).toEqual([]);
    expect(h.ports.unavailable).not.toHaveBeenCalled();
  });

  it.each(['rejection', 'error field'] as const)(
    'reports a bootstrap %s without preparing or seeding',
    async (mode) => {
      const h = harness();
      if (mode === 'rejection') vi.mocked(h.ports.load).mockRejectedValue(new Error('unavailable'));
      else vi.mocked(h.ports.load).mockResolvedValue({ error: 'unavailable' });
      await bootstrapSessionIdentity({ sbSlug: 'echo' }, h.ports);
      expect(h.ports.unavailable).toHaveBeenCalledWith(
        expect.stringMatching(/^bootstrap unavailable:/)
      );
      expect(h.ports.prepareHost).not.toHaveBeenCalled();
      expect(h.ports.setContext).not.toHaveBeenCalled();
      expect(h.ports.seedMemoryIds).not.toHaveBeenCalled();
      expect(h.ports.ledger.listEntries()).toEqual([]);
    }
  );

  it.each([{ error: 'unavailable' }, {}])(
    'a required host refuses unusable bootstrap %j',
    async (result) => {
      const h = harness();
      vi.mocked(h.ports.load).mockResolvedValue(result);
      vi.mocked(h.ports.unavailable).mockImplementation((reason) => {
        throw new Error(reason);
      });
      await expect(bootstrapSessionIdentity({ sbSlug: 'echo' }, h.ports)).rejects.toThrow(
        'bootstrap'
      );
      expect(h.ports.prepareHost).not.toHaveBeenCalled();
      expect(h.ports.ledger.listEntries()).toEqual([]);
    }
  );

  it('preserves the interactive host allowance for empty identity context', async () => {
    const h = harness();
    vi.mocked(h.ports.load).mockResolvedValue({});
    await bootstrapSessionIdentity({ sbSlug: 'echo' }, h.ports);
    expect(h.ports.unavailable).toHaveBeenCalledWith('bootstrap returned no identity context');
    expect(h.ports.setContext).not.toHaveBeenCalled();
    expect(h.ports.prepareHost).toHaveBeenCalledOnce();
    expect(h.ports.seedMemoryIds).not.toHaveBeenCalled();
    expect(h.ports.ledger.listEntries()[0].content).toBe('Bootstrapped as echo');
  });

  it('does not seed or add a marker if host preparation fails', async () => {
    const h = harness();
    vi.mocked(h.ports.prepareHost).mockRejectedValue(new Error('host refused'));
    await expect(bootstrapSessionIdentity({ sbSlug: 'echo' }, h.ports)).rejects.toThrow(
      'host refused'
    );
    expect(h.ports.setContext).toHaveBeenCalledOnce();
    expect(h.ports.seedMemoryIds).not.toHaveBeenCalled();
    expect(h.ports.ledger.listEntries()).toEqual([]);
  });

  it('pre-aborted preparation does not call any port', async () => {
    const h = harness();
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    await expect(
      bootstrapSessionIdentity({ sbSlug: 'echo' }, h.ports, stop.signal)
    ).rejects.toThrow('stopped');
    expect(h.order).toEqual([]);
  });

  it.each(['load', 'prepareHost'] as const)(
    'fences application after Stop while %s was pending',
    async (boundary) => {
      const h = harness();
      const stop = new AbortController();
      if (boundary === 'load')
        vi.mocked(h.ports.load).mockImplementation(async () => {
          stop.abort(new Error('stopped'));
          return h.result;
        });
      else
        vi.mocked(h.ports.prepareHost).mockImplementation(async () => {
          stop.abort(new Error('stopped'));
        });
      await expect(
        bootstrapSessionIdentity({ sbSlug: 'echo' }, h.ports, stop.signal)
      ).rejects.toThrow('stopped');
      if (boundary === 'load') expect(h.ports.setContext).not.toHaveBeenCalled();
      expect(h.ports.seedMemoryIds).not.toHaveBeenCalled();
      expect(h.ports.ledger.listEntries()).toEqual([]);
    }
  );

  it('does not share context or dedup when two hosts bootstrap concurrently', async () => {
    const a = harness();
    const b = harness();
    let release!: (value: Record<string, unknown>) => void;
    vi.mocked(a.ports.load).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const pending = bootstrapSessionIdentity({ sbSlug: 'echo-a' }, a.ports);
    await bootstrapSessionIdentity({ sbSlug: 'echo-b' }, b.ports);
    expect(a.ports.seedMemoryIds).not.toHaveBeenCalled();
    release({ identityFiles: { soul: 'A different identity.' }, memoryIds: ['memory-b'] });
    await pending;
    expect(a.ports.seedMemoryIds).toHaveBeenCalledWith(['memory-b']);
    expect(b.ports.seedMemoryIds).toHaveBeenCalledWith(['memory-a']);
    expect(a.ports.ledger.listEntries()[0].content).toBe('Bootstrapped as echo-a');
  });
});
