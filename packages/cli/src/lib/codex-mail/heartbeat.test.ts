import { describe, expect, it, vi } from 'vitest';
import { pulseCodexMail } from './heartbeat.js';

describe('Codex mail delivery freshness', () => {
  it('healthy backpressure does not block a separate heartbeat', async () => {
    const stamp = vi.fn(async () => {});
    await pulseCodexMail({
      usable: () => true,
      lastDiscovery: () => 10,
      now: () => 1000,
      probe: async () => ({ data: [{ clientUserMessageId: 'still-queued' }] }),
      credential: async () => 'fixture',
      stamp,
    });
    expect(stamp).toHaveBeenCalledOnce();
  });
  it('does not stamp a dead owner or disconnected/changed terminal', async () => {
    const stamp = vi.fn(async () => {}),
      probe = vi.fn(async () => {});
    expect(
      await pulseCodexMail({
        usable: () => false,
        lastDiscovery: () => Date.now(),
        probe,
        credential: async () => 'fixture',
        stamp,
      })
    ).toBe(false);
    expect(stamp).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
  it('checks again after owner death during a pending probe', async () => {
    let live = true;
    const stamp = vi.fn(async () => {});
    await pulseCodexMail({
      usable: () => live,
      lastDiscovery: () => Date.now(),
      probe: async () => {
        live = false;
      },
      credential: async () => 'fixture',
      stamp,
    });
    expect(stamp).not.toHaveBeenCalled();
  });
  it('mailbox outage expires its reader evidence; failed probes never stamp', async () => {
    const stamp = vi.fn(async () => {});
    await pulseCodexMail({
      usable: () => true,
      lastDiscovery: () => 1,
      now: () => 21002,
      probe: async () => {},
      credential: async () => 'fixture',
      stamp,
    });
    expect(stamp).not.toHaveBeenCalled();
    await expect(
      pulseCodexMail({
        usable: () => true,
        lastDiscovery: () => Date.now(),
        probe: async () => {
          throw new Error('owner gone');
        },
        credential: async () => 'fixture',
        stamp,
      })
    ).rejects.toThrow();
    expect(stamp).not.toHaveBeenCalled();
  });
});
