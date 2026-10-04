// @vitest-environment jsdom
/**
 * ThreadConversation and reactions (spec inkling-reactions): offered to a
 * member only, a tap posts the right toggle, and the answer shows on the
 * message until a newer page carries it. The view is a probe that records
 * what it is given. The mutation hook and QueryClient are the real ones;
 * only the HTTP transport is faked, so each write is a request the test
 * answers when it chooses (Lumen's #742 harness).
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import {
  THREAD_REACTIONS_PATH,
  type ThreadMessage,
  type ThreadMessagesResponse,
  type ThreadReaction,
  type ThreadReactionRequest,
  type ThreadSpine,
} from '@inklabs/shared/stories/threads-api';
import { apiClient } from '@/lib/api/client';
import { createReadCursorStore } from './read-cursors';

const fake = vi.hoisted(() => ({
  page: undefined as unknown,
  updatedAt: 1,
  view: {
    onReact: undefined as unknown,
    messages: [] as Array<{ id: string; reactions?: unknown }>,
  },
}));

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  useWorkspaceApiQuery: () => ({
    data: fake.page,
    dataUpdatedAt: fake.updatedAt,
    isLoading: false,
  }),
  apiGet: () => Promise.resolve({ thread: null, messages: [] }),
}));
vi.mock('./reply-composer', () => ({ ReplyComposer: () => null }));
vi.mock('./reopen-button', () => ({ ReopenThreadButton: () => null }));
vi.mock('@/components/conversation/conversation-view', () => ({
  ConversationView: (props: {
    onReact?: unknown;
    messages: Array<{ id: string; reactions?: unknown }>;
  }) => {
    fake.view = { onReact: props.onReact, messages: props.messages };
    return null;
  },
}));

import { ThreadConversation } from './thread-conversation';

const KEY = 'fixture:thread:reactions';
const at = (i: number) => new Date(Date.UTC(2026, 9, 4, 0, i)).toISOString();
const message = (id: string, i: number, reactions: ThreadMessage['reactions']): ThreadMessage => ({
  id,
  senderKind: 'sb',
  senderSlug: 'wren',
  content: `Message ${id}`,
  createdAt: at(i),
  messageType: 'message',
  priority: 'normal',
  reactions,
});
const page = (...messages: ThreadMessage[]): ThreadMessagesResponse => ({
  thread: null,
  messages,
  meta: { fetched: messages.length, total: messages.length, truncated: false },
});
const mine = (emoji: string): ThreadReaction => ({
  emoji,
  count: 1,
  reactors: [{ kind: 'user', id: 'u-me' }],
  mine: true,
});
const shown = (emoji: string) => ({ emoji, count: 1, mine: true });

function spineWith(people: Array<{ userId: string; name: string; isOwn: boolean }>): ThreadSpine {
  return {
    key: KEY,
    sources: ['thread'],
    thread: {
      title: null,
      status: 'open',
      createdBySlug: 'wren',
      participants: ['wren'],
      people,
      closedAt: null,
    },
    participants: ['wren'],
    sessions: [],
    studios: [],
    taskGroups: [],
    identity: null,
    lastActivityAt: at(10),
  } as ThreadSpine;
}
const ME = { userId: 'u-me', name: 'You', isOwn: true };
const SOMEONE = { userId: 'u-else', name: 'Someone', isOwn: false };

/** One reaction request in flight, answered (or failed) when the test says. */
interface Pending {
  body: ThreadReactionRequest;
  answer: (reactions: ThreadReaction[]) => void;
  fail: () => void;
}
let pending: Pending[];
let client: QueryClient;
let savedAdapter: typeof apiClient.defaults.adapter;

beforeEach(() => {
  pending = [];
  fake.updatedAt = 1;
  client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  savedAdapter = apiClient.defaults.adapter;
  const adapter: AxiosAdapter = (config: InternalAxiosRequestConfig) => {
    if (config.method !== 'post' || config.url !== THREAD_REACTIONS_PATH) {
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    }
    const body = JSON.parse(config.data as string) as ThreadReactionRequest;
    return new Promise((resolve, reject) =>
      pending.push({
        body,
        answer: (reactions) =>
          resolve({
            data: { messageId: body.messageId, reactions },
            status: 200,
            statusText: 'OK',
            headers: {},
            config,
          }),
        fail: () =>
          reject(
            Object.assign(new Error('Request failed with status code 500'), {
              isAxiosError: true,
              config,
              response: {
                data: { error: 'boom' },
                status: 500,
                statusText: 'Error',
                headers: {},
                config,
              },
            })
          ),
      })
    );
  };
  apiClient.defaults.adapter = adapter;
});

afterEach(() => {
  cleanup();
  client.clear();
  apiClient.defaults.adapter = savedAdapter;
});

function mount(spine: ThreadSpine) {
  const cursors = createReadCursorStore(null, () => new Date(at(100)));
  const ui = () => (
    <QueryClientProvider client={client}>
      <ThreadConversation
        spine={spine}
        workspaceId="fixture-workspace"
        nameFor={(s) => s}
        cursors={cursors}
        onBack={() => {}}
        detailsOpen={false}
        onToggleDetails={() => {}}
      />
    </QueryClientProvider>
  );
  const rendered = render(ui());
  return { rerender: () => rendered.rerender(ui()) };
}
const react = (messageId: string, emoji: string) =>
  act(() => (fake.view.onReact as (messageId: string, emoji: string) => void)(messageId, emoji));
const reactionsOf = (id: string) => fake.view.messages.find((m) => m.id === id)?.reactions;
const bodies = () => pending.map((p) => p.body);
/** Let any queued write start, so a held one would have shown up. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

describe('ThreadConversation reactions', () => {
  it('offers reacting to a member of the thread only', () => {
    fake.page = page(message('m1', 1, []));
    mount(spineWith([ME]));
    expect(typeof fake.view.onReact).toBe('function');
    cleanup();
    mount(spineWith([SOMEONE]));
    expect(fake.view.onReact).toBeUndefined();
    cleanup();
    mount(spineWith([]));
    expect(fake.view.onReact).toBeUndefined();
  });

  it('posts the toggle: takes back the viewer’s own emoji, adds any other', async () => {
    fake.page = page(message('m1', 1, [mine('❤️')]));
    mount(spineWith([ME]));
    react('m1', '❤️');
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0].answer([]));
    react('m1', '👍');
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(bodies()).toEqual([
      { threadKey: KEY, messageId: 'm1', emoji: '❤️', remove: true },
      { threadKey: KEY, messageId: 'm1', emoji: '👍', remove: false },
    ]);
  });

  it('shows the answer on the message until a newer page carries that message', async () => {
    fake.page = page(message('m1', 1, []), message('m2', 2, []));
    const view = mount(spineWith([ME]));
    react('m1', '👍');
    react('m2', '👍');
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[0].answer([mine('👍')]);
      pending[1].answer([mine('👍')]);
    });
    await waitFor(() => expect(reactionsOf('m1')).toEqual([shown('👍')]));

    // The next poll carries m2 (with what the server now says) but not m1.
    fake.page = page(message('m2', 2, [mine('❤️')]));
    fake.updatedAt = 2;
    act(() => view.rerender());
    expect(reactionsOf('m2')).toEqual([shown('❤️')]);
    expect(reactionsOf('m1')).toEqual([shown('👍')]);
  });

  it('never shows reactions on a message from a server that sent none', async () => {
    fake.page = page(message('m1', 1, undefined));
    mount(spineWith([ME]));
    react('m1', '👍');
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0].answer([]));
    await settle();
    expect(reactionsOf('m1')).toBeUndefined();
  });

  describe('one write at a time per message (Lumen, #742 r1)', () => {
    it('holds a message’s second write until the first answers', async () => {
      // An older message the newest page no longer carries: no poll repairs it.
      fake.page = page(message('older', 1, []), message('newer', 2, []));
      const view = mount(spineWith([ME]));
      fake.page = page(message('newer', 2, []));
      fake.updatedAt = 2;
      act(() => view.rerender());

      react('older', '❤️');
      react('older', '👍');
      await waitFor(() => expect(pending).toHaveLength(1));
      await settle();
      expect(pending).toHaveLength(1);

      await act(async () => pending[0].answer([mine('❤️')]));
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(bodies()[1]).toEqual({
        threadKey: KEY,
        messageId: 'older',
        emoji: '👍',
        remove: false,
      });
      await act(async () => pending[1].answer([mine('❤️'), mine('👍')]));
      await waitFor(() => expect(reactionsOf('older')).toEqual([shown('❤️'), shown('👍')]));
    });

    it('works out each queued toggle from the answer before it: a double tap adds, then takes back', async () => {
      fake.page = page(message('m1', 1, []));
      mount(spineWith([ME]));
      react('m1', '❤️');
      react('m1', '❤️');
      await waitFor(() => expect(pending).toHaveLength(1));
      await act(async () => pending[0].answer([mine('❤️')]));
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(bodies()).toEqual([
        { threadKey: KEY, messageId: 'm1', emoji: '❤️', remove: false },
        { threadKey: KEY, messageId: 'm1', emoji: '❤️', remove: true },
      ]);
      await act(async () => pending[1].answer([]));
      await waitFor(() => expect(reactionsOf('m1')).toEqual([]));
    });

    it('sends the next write after a failed one, from what the message shows', async () => {
      fake.page = page(message('m1', 1, [mine('❤️')]));
      mount(spineWith([ME]));
      react('m1', '👍');
      react('m1', '❤️');
      await waitFor(() => expect(pending).toHaveLength(1));
      await act(async () => pending[0].fail());
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(bodies()[1]).toEqual({ threadKey: KEY, messageId: 'm1', emoji: '❤️', remove: true });
    });

    it('after a failure, reads what the message shows, not an answer from before it', async () => {
      fake.page = page(message('m1', 1, []));
      const view = mount(spineWith([ME]));
      // Three taps queue up: ❤️, then 👍 twice.
      react('m1', '❤️');
      react('m1', '👍');
      react('m1', '👍');
      await waitFor(() => expect(pending).toHaveLength(1));
      await act(async () => pending[0].answer([mine('❤️')]));
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(bodies()[1]).toEqual({ threadKey: KEY, messageId: 'm1', emoji: '👍', remove: false });
      // A newer page carries the message with the 👍 stored after all, and
      // then the write that stored it answers with a failure.
      fake.page = page(message('m1', 1, [mine('❤️'), mine('👍')]));
      fake.updatedAt = 2;
      act(() => view.rerender());
      await act(async () => pending[1].fail());
      await waitFor(() => expect(pending).toHaveLength(3));
      expect(bodies()[2]).toEqual({ threadKey: KEY, messageId: 'm1', emoji: '👍', remove: true });
    });

    it('does not hold one message’s write behind another’s', async () => {
      fake.page = page(message('m1', 1, []), message('m2', 2, []));
      mount(spineWith([ME]));
      react('m1', '❤️');
      react('m2', '❤️');
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(bodies().map((b) => b.messageId)).toEqual(['m1', 'm2']);
    });
  });
});
