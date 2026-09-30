import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexMailDelivery, digest, PendingCodexDelivery } from './delivery.js';
import { createCodexMailPoller } from './poller.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ink-mail-test-'));
  dirs.push(directory);
  const added: any[] = [];
  let items: any[] = [];
  let queue: any[] = [];
  let loseResponse = false;
  const request = vi.fn(async (method: string, params: any) => {
    if (method === 'thread/queue/add') {
      added.push(params);
      queue.push(params);
      if (loseResponse) throw new Error('response lost');
      return { queuedSubmission: { id: 'queue-id' } };
    }
    if (method === 'thread/items/list') return { data: items, nextCursor: null };
    if (method === 'thread/queue/list') return { data: queue, nextCursor: null };
    throw new Error('Unexpected method');
  });
  const make = (threadId = 'codex-thread') =>
    new CodexMailDelivery({ directory, scope: 'fixture-session', threadId, rpc: { request } });
  const receipt = (input = added[0]) => ({
    method: 'item/completed',
    params: {
      threadId: input.threadId,
      item: { type: 'userMessage', clientId: input.clientUserMessageId, content: input.input },
    },
  });
  return {
    directory,
    added,
    request,
    make,
    receipt,
    loseResponse: () => {
      loseResponse = true;
    },
    deliveredInHistory: () => {
      items = [{ item: receipt().params.item, turnId: 'turn', completedAtMs: 1 }];
      queue = [];
    },
    missingEverywhere: () => {
      items = [];
      queue = [];
    },
  };
}
const meta = { sender: 'fixture-peer', thread_key: 'thread:fixture' };

describe('Codex Inkmail receipt boundary', () => {
  it('does not treat queue acceptance as delivery; retries do not duplicate', async () => {
    const f = fixture(),
      d = f.make();
    await expect(d.deliver('message', 'hello', meta)).rejects.toBeInstanceOf(PendingCodexDelivery);
    await expect(d.deliver('message', 'hello', meta)).rejects.toBeInstanceOf(PendingCodexDelivery);
    expect(f.added).toHaveLength(1);
    d.observe(f.receipt());
    await d.deliver('message', 'hello', meta);
    expect(f.added).toHaveLength(1);
  });
  it('ignores wrong-thread, wrong-client and changed-content receipts', async () => {
    const f = fixture(),
      d = f.make();
    await expect(d.deliver('message', 'hello', meta)).rejects.toThrow();
    for (const change of ['thread', 'client', 'content']) {
      const event = structuredClone(f.receipt());
      if (change === 'thread') event.params.threadId = 'foreign';
      if (change === 'client') event.params.item.clientId = 'foreign';
      if (change === 'content') event.params.item.content = [{ type: 'text', text: 'foreign' }];
      d.observe(event);
      await expect(d.deliver('message', 'hello', meta)).rejects.toBeInstanceOf(
        PendingCodexDelivery
      );
    }
    expect(f.added).toHaveLength(1);
  });
  it('reconciles lost queue response across a restart, including still-queued input', async () => {
    const f = fixture();
    f.loseResponse();
    await expect(f.make().deliver('message', 'hello', meta)).rejects.toThrow('response lost');
    await expect(f.make().deliver('message', 'hello', meta)).rejects.toBeInstanceOf(
      PendingCodexDelivery
    );
    f.deliveredInHistory();
    await f.make().deliver('message', 'hello', meta);
    expect(f.added).toHaveLength(1);
  });
  it('never resends an ambiguous intent just because bounded history and queue are empty', async () => {
    const f = fixture();
    await expect(f.make().deliver('message', 'hello', meta)).rejects.toThrow();
    f.missingEverywhere();
    await expect(f.make().deliver('message', 'hello', meta)).rejects.toThrow('uncertain');
    expect(f.added).toHaveLength(1);
  });
  it('durable receipt survives restart and ACK failure without any more Codex calls', async () => {
    const f = fixture(),
      d = f.make();
    await expect(d.deliver('message', 'hello', meta)).rejects.toThrow();
    d.observe(f.receipt());
    f.request.mockClear();
    await f.make().deliver('message', 'hello', meta);
    expect(f.request).not.toHaveBeenCalled();
  });
  it('refuses pending re-routing and mutated message identities', async () => {
    const f = fixture();
    await expect(f.make().deliver('message', 'hello', meta)).rejects.toThrow();
    await expect(f.make('other-thread').deliver('message', 'hello', meta)).rejects.toThrow(
      'different Codex thread'
    );
    await expect(f.make().deliver('message', 'changed', meta)).rejects.toThrow('content changed');
    expect(f.added).toHaveLength(1);
  });
  it('stores no message body and fails closed on corrupt journal', async () => {
    const f = fixture();
    await expect(f.make().deliver('message', 'PRIVATE_FIXTURE_BODY', meta)).rejects.toThrow();
    const dir = join(f.directory, digest('fixture-session'));
    const path = join(dir, readdirSync(dir)[0]);
    expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE_FIXTURE_BODY');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, 'corrupt fixture');
    await expect(f.make().deliver('message', 'PRIVATE_FIXTURE_BODY', meta)).rejects.toThrow();
    expect(f.added).toHaveLength(1);
  });
  it('exclusive send-intent prevents concurrent callers sending twice', async () => {
    const f = fixture();
    await Promise.allSettled([
      f.make().deliver('message', 'hello', meta),
      f.make().deliver('message', 'hello', meta),
    ]);
    expect(f.added).toHaveLength(1);
  });
  it('shared drain fetches without consuming, then ACKs only after the exact receipt', async () => {
    const f = fixture(),
      d = f.make();
    const ink = vi.fn(async (tool: string, args: any) => {
      if (tool === 'get_inbox')
        return {
          success: true,
          messages: [],
          threadsWithUnread: [{ threadKey: 'thread:fixture', unreadCount: 1 }],
        };
      if (tool === 'get_thread_messages')
        return {
          success: true,
          messages: [
            {
              id: 'message',
              content: 'hello',
              senderSlug: 'peer',
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
        };
      return { success: true };
    });
    const poll = createCodexMailPoller({
      sbSlug: 'fixture',
      studioId: 'studio',
      callInk: ink,
      notify: async (content, metadata, msg) => {
        if (msg) await d.deliver(String(msg.id), content, metadata);
      },
      log: () => {},
    });
    await poll();
    expect(ink.mock.calls.filter(([name]) => name.startsWith('mark_'))).toEqual([]);
    expect(
      ink.mock.calls
        .filter(([name]) => name.startsWith('get_'))
        .every(([, args]) => args.markRead === false)
    ).toBe(true);
    d.observe(f.receipt());
    await poll();
    expect(ink).toHaveBeenCalledWith(
      'mark_thread_read',
      expect.objectContaining({ threadKey: 'thread:fixture', throughMessageId: 'message' })
    );
    expect(f.added).toHaveLength(1);
  });
});
