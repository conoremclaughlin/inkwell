import { describe, expect, it } from 'vitest';
import { CodexMailDiagnostics } from './diagnostics.js';
import { PendingCodexDelivery } from './delivery.js';

describe('Codex mail diagnostics', () => {
  it('names each held message/thread, repeats after one minute, and reports recovery', async () => {
    const messages: string[] = [];
    let now = 0;
    const diagnostics = new CodexMailDiagnostics(
      (m) => messages.push(m),
      () => now
    );
    let uncertain = true;
    const delivery = {
      deliver: async () => {
        if (uncertain) throw new Error('acceptance is uncertain');
      },
    };
    const send = (id = 'm1', thread = 'thread:fixture') =>
      diagnostics.deliver(delivery, id, 'hello', { thread_key: thread });
    await expect(send()).rejects.toThrow('uncertain');
    await expect(send()).rejects.toThrow();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('message m1 in thread:fixture');
    expect(messages[0]).toContain('Later mail behind this message is held unread');
    await expect(send('m2', 'thread:other')).rejects.toThrow();
    expect(messages[1]).toContain('message m2 in thread:other');
    now = 60_000;
    await expect(send()).rejects.toThrow();
    expect(messages).toHaveLength(3);
    // A transient scan gap can recover on the very next receipt. Do not keep
    // presenting its initial absence as a permanent loss.
    uncertain = false;
    await send();
    expect(messages[3]).toContain('Exact receipt confirmed for message m1 in thread:fixture');
    await send();
    expect(messages).toHaveLength(4);
  });
  it('keeps ordinary queue backpressure quiet and identifies the global legacy boundary', async () => {
    const messages: string[] = [];
    const diagnostics = new CodexMailDiagnostics((m) => messages.push(m));
    const queued = {
      deliver: async () => {
        throw new PendingCodexDelivery('queued');
      },
    };
    await expect(diagnostics.deliver(queued, 'm1', 'hello', {})).rejects.toThrow();
    expect(messages).toEqual([]);
    const lost = {
      deliver: async () => {
        throw new Error('uncertain');
      },
    };
    await expect(diagnostics.deliver(lost, 'm1', 'hello', {})).rejects.toThrow();
    expect(messages[0]).toContain('legacy inbox (global read pointer)');
  });
  it('rate-limits generic transport warnings instead of suppressing them forever', () => {
    const messages: string[] = [];
    let now = 100;
    const diagnostics = new CodexMailDiagnostics(
      (m) => messages.push(m),
      () => now
    );
    diagnostics.warn('mailbox poll failed');
    diagnostics.warn('mailbox poll failed');
    expect(messages).toHaveLength(1);
    now += 60_000;
    diagnostics.warn('mailbox poll failed');
    expect(messages).toHaveLength(2);
  });
});
