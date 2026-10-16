/**
 * A person's pin on one of their threads (services/threads/thread-pins.ts):
 * the strict body rule, and the write, against a fake that records every
 * query-builder call so the exact UPDATE (its patch and both filters) is
 * what is asserted, not merely its outcome.
 */

import { describe, expect, it } from 'vitest';
import { PinRefusedError, parsePinBody, setThreadPin, type PinRequest } from './thread-pins';

const ME = '11111111-1111-4111-8111-111111111111';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THREAD_ID = '00000000-0000-4000-8000-000000000001';

type Call = [method: string, ...args: unknown[]];
interface Recorded {
  table: string;
  calls: Call[];
}

/**
 * Every from() is one recorded query. `answers` says what each table's
 * query resolves to: inbox_threads through maybeSingle(), the participant
 * update by being awaited after select().
 */
function recordingClient(answers: {
  thread?: { data: unknown; error: unknown };
  update?: { data: unknown; error: unknown };
}) {
  const queries: Recorded[] = [];
  const client = {
    from(table: string) {
      const query: Recorded = { table, calls: [] };
      queries.push(query);
      const result =
        table === 'inbox_threads'
          ? (answers.thread ?? { data: { id: THREAD_ID }, error: null })
          : (answers.update ?? { data: [{ thread_id: THREAD_ID }], error: null });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      for (const method of ['select', 'update', 'insert', 'upsert', 'delete', 'eq', 'in', 'is']) {
        chain[method] = (...args: unknown[]) => {
          query.calls.push([method, ...args]);
          return chain;
        };
      }
      chain.maybeSingle = () => {
        query.calls.push(['maybeSingle']);
        return Promise.resolve(result);
      };
      return chain;
    },
  };
  return { client, queries };
}

const request = (over: Partial<PinRequest> = {}): PinRequest => ({
  workspaceId: WS,
  userId: ME,
  threadKey: 'chat:pip',
  pinned: true,
  ...over,
});

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PinRefusedError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal, got an answer');
}

function refusedParse(body: unknown): { status: number; code: string } {
  try {
    parsePinBody(body);
  } catch (error) {
    if (error instanceof PinRefusedError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal, got a body');
}

describe('parsePinBody', () => {
  it('takes each of the three states, and trims the key', () => {
    expect(parsePinBody({ threadKey: ' chat:pip ', pinned: true })).toEqual({
      threadKey: 'chat:pip',
      pinned: true,
    });
    expect(parsePinBody({ threadKey: 'chat:pip', pinned: false }).pinned).toBe(false);
    expect(parsePinBody({ threadKey: 'chat:pip', pinned: null }).pinned).toBeNull();
  });

  it('refuses a missing or blank threadKey with invalid_thread_key', () => {
    for (const body of [
      { pinned: true },
      { threadKey: '', pinned: true },
      { threadKey: '   ', pinned: true },
      { threadKey: 42, pinned: true },
      null,
      'chat:pip',
    ]) {
      expect(refusedParse(body)).toEqual({ status: 400, code: 'invalid_thread_key' });
    }
  });

  it('refuses a pinned that is missing or not exactly true, false or null', () => {
    for (const pinned of [undefined, 'true', 1, 0, 'false', {}, []]) {
      expect(refusedParse({ threadKey: 'chat:pip', pinned })).toEqual({
        status: 400,
        code: 'invalid_pinned',
      });
    }
    // A key with no `pinned` at all is a malformed request, not "clear it".
    expect(refusedParse({ threadKey: 'chat:pip' })).toEqual({
      status: 400,
      code: 'invalid_pinned',
    });
  });
});

describe('setThreadPin', () => {
  it('finds the thread in the caller workspace by key, then writes exactly { pinned } on their own row', async () => {
    for (const pinned of [true, false, null]) {
      const { client, queries } = recordingClient({});
      const result = await setThreadPin(client, request({ pinned }));
      expect(result).toEqual({ threadKey: 'chat:pip', pinned });

      expect(queries.map((q) => q.table)).toEqual(['inbox_threads', 'inbox_thread_participants']);
      expect(queries[0].calls).toEqual([
        ['select', 'id, metadata, conversation_mode'],
        ['eq', 'workspace_id', WS],
        ['eq', 'thread_key', 'chat:pip'],
        ['maybeSingle'],
      ]);
      expect(queries[1].calls).toEqual([
        ['update', { pinned }],
        ['eq', 'thread_id', THREAD_ID],
        ['eq', 'user_id', ME],
        ['select', 'thread_id'],
      ]);
    }
  });

  it('answers 404 thread_not_found for a key with no thread in this workspace, and writes nothing', async () => {
    const { client, queries } = recordingClient({ thread: { data: null, error: null } });
    expect(await refusal(setThreadPin(client, request()))).toEqual({
      status: 404,
      code: 'thread_not_found',
    });
    expect(queries.map((q) => q.table)).toEqual(['inbox_threads']);
  });

  it('answers 403 background_thread when the person has no row on the thread', async () => {
    const { client } = recordingClient({ update: { data: [], error: null } });
    expect(await refusal(setThreadPin(client, request()))).toEqual({
      status: 403,
      code: 'background_thread',
    });
  });

  // D3: a participant-only conversation is no thread at all to anyone not in
  // it, so the person who has no row gets the missing-thread answer.
  it('answers 404 thread_not_found for a participant-only conversation the person is not in', async () => {
    const { client } = recordingClient({
      thread: { data: { id: THREAD_ID, metadata: { inklingConversation: true } }, error: null },
      update: { data: [], error: null },
    });
    expect(await refusal(setThreadPin(client, request()))).toEqual({
      status: 404,
      code: 'thread_not_found',
    });
  });

  it('pins a participant-only conversation for a person on it', async () => {
    const { client } = recordingClient({
      thread: { data: { id: THREAD_ID, metadata: { inklingConversation: true } }, error: null },
    });
    expect(await setThreadPin(client, request())).toEqual({ threadKey: 'chat:pip', pinned: true });
  });

  it('throws, not refuses, when either query fails', async () => {
    const lookupFails = recordingClient({ thread: { data: null, error: { message: 'down' } } });
    await expect(setThreadPin(lookupFails.client, request())).rejects.toThrow(
      'Failed to find the thread: down'
    );
    const writeFails = recordingClient({ update: { data: null, error: { message: 'down' } } });
    await expect(setThreadPin(writeFails.client, request())).rejects.toThrow(
      'Failed to set the pin: down'
    );
  });
});
