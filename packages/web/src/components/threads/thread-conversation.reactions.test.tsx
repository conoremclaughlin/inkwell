// @vitest-environment jsdom
/**
 * ThreadConversation and reactions (spec inkling-reactions): offered to a
 * member only, a tap posts the right toggle, and the answer shows on the
 * message until a newer page carries it. The view is a probe that records
 * what it is given.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THREAD_REACTIONS_PATH,
  type ThreadMessage,
  type ThreadMessagesResponse,
  type ThreadSpine,
} from '@inklabs/shared/stories/threads-api';
import { createReadCursorStore } from './read-cursors';

const fake = vi.hoisted(() => ({
  page: undefined as unknown,
  updatedAt: 1,
  mutate: vi.fn(),
  invalidate: vi.fn(),
  postPath: '',
  onSuccess: undefined as undefined | ((result: unknown) => void),
  view: {
    onReact: undefined as unknown,
    messages: [] as Array<{ id: string; reactions?: unknown }>,
  },
}));

vi.mock('@/lib/api', () => ({
  useWorkspaceApiQuery: () => ({
    data: fake.page,
    dataUpdatedAt: fake.updatedAt,
    isLoading: false,
  }),
  apiGet: () => Promise.resolve({ thread: null, messages: [] }),
  useApiPost: (path: string, options: { onSuccess: (result: unknown) => void }) => {
    fake.postPath = path;
    fake.onSuccess = options.onSuccess;
    return { mutate: fake.mutate, isError: false, error: null };
  },
  useQueryClient: () => ({ invalidateQueries: fake.invalidate }),
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
const heartMine = [{ emoji: '❤️', count: 1, reactors: [], mine: true }];

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

function mount(spine: ThreadSpine) {
  const ui = () => (
    <ThreadConversation
      spine={spine}
      workspaceId="fixture-workspace"
      nameFor={(s) => s}
      cursors={createReadCursorStore(null, () => new Date(at(100)))}
      onBack={() => {}}
      detailsOpen={false}
      onToggleDetails={() => {}}
    />
  );
  const rendered = render(ui());
  return { rerender: () => rendered.rerender(ui()) };
}
const reactionsOf = (id: string) => fake.view.messages.find((m) => m.id === id)?.reactions;

afterEach(() => {
  cleanup();
  fake.mutate.mockReset();
  fake.invalidate.mockReset();
  fake.updatedAt = 1;
});

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

  it('posts the toggle: takes back the viewer’s own emoji, adds any other', () => {
    fake.page = page(message('m1', 1, heartMine));
    mount(spineWith([ME]));
    const onReact = fake.view.onReact as (messageId: string, emoji: string) => void;
    onReact('m1', '❤️');
    onReact('m1', '👍');
    expect(fake.postPath).toBe(THREAD_REACTIONS_PATH);
    expect(fake.mutate.mock.calls.map(([body]) => body)).toEqual([
      { threadKey: KEY, messageId: 'm1', emoji: '❤️', remove: true },
      { threadKey: KEY, messageId: 'm1', emoji: '👍', remove: false },
    ]);
  });

  it('shows the answer on the message until a newer page carries that message', () => {
    fake.page = page(message('m1', 1, []), message('m2', 2, []));
    const view = mount(spineWith([ME]));
    const answer = [
      { emoji: '👍', count: 1, reactors: [{ kind: 'user', id: 'u-me' }], mine: true },
    ];
    act(() => {
      fake.onSuccess?.({ messageId: 'm1', reactions: answer });
      fake.onSuccess?.({ messageId: 'm2', reactions: answer });
    });
    expect(reactionsOf('m1')).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    expect(fake.invalidate).toHaveBeenCalledWith({ queryKey: ['thread-messages', KEY] });

    // The next poll carries m2 (with what the server now says) but not m1.
    fake.page = page(message('m2', 2, heartMine));
    fake.updatedAt = 2;
    act(() => view.rerender());
    expect(reactionsOf('m2')).toEqual([{ emoji: '❤️', count: 1, mine: true }]);
    expect(reactionsOf('m1')).toEqual([{ emoji: '👍', count: 1, mine: true }]);
  });

  it('never shows reactions on a message from a server that sent none', () => {
    fake.page = page(message('m1', 1, undefined));
    mount(spineWith([ME]));
    act(() => fake.onSuccess?.({ messageId: 'm1', reactions: [] }));
    expect(reactionsOf('m1')).toBeUndefined();
  });
});
