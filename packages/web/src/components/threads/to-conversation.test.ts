import { describe, expect, it } from 'vitest';
import { nameLookup, plainPreview, toConversationMessage } from './to-conversation';
import type { ThreadMessage } from './thread-types';

const names = nameLookup([
  { sbSlug: 'wren', name: 'Wren' },
  { sbSlug: 'lumen', name: '  ' },
]);

const message = (over: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: 'm1',
  senderSlug: 'wren',
  content: 'hello',
  messageType: 'message',
  priority: 'normal',
  metadata: {},
  createdAt: '2026-09-23T10:00:00Z',
  ...over,
});

describe('toConversationMessage', () => {
  it('names an SB from its identity, and keeps the slug when there is no usable name', () => {
    expect(toConversationMessage(message(), names).author).toEqual({
      kind: 'sb',
      id: 'wren',
      name: 'Wren',
      isOwn: false,
    });
    expect(toConversationMessage(message({ senderSlug: 'lumen' }), names).author.name).toBe(
      'lumen'
    );
  });

  it('reads a person’s reply as the viewer’s own, whatever the sender slot says', () => {
    const author = toConversationMessage(
      message({ senderSlug: 'unknown', metadata: { sentBy: 'user' } }),
      names
    ).author;
    expect(author).toMatchObject({ kind: 'user', name: 'You', isOwn: true });
  });

  it('turns system events into event rows without a label', () => {
    const event = toConversationMessage(
      message({ senderSlug: 'system', messageType: 'system', content: 'Thread closed by wren' }),
      names
    );
    expect(event.author.kind).toBe('system');
    expect(event.label).toBeUndefined();
  });

  it('labels task requests and notifications, never plain messages', () => {
    expect(toConversationMessage(message({ messageType: 'task_request' }), names).label).toBe(
      'task_request'
    );
    expect(toConversationMessage(message(), names).label).toBeUndefined();
  });

  it('prefers a server that names principals over the metadata marker', () => {
    // Another person's message, as spec inkmail-thread-scope §3 payloads say it.
    const other = toConversationMessage(
      message({
        senderKind: 'user',
        senderName: 'Sam',
        isOwn: false,
        metadata: { sentBy: 'user' },
      }),
      names
    );
    expect(other.author).toMatchObject({ kind: 'user', name: 'Sam', isOwn: false });
  });

  it('drops a priority it does not recognise instead of passing it through', () => {
    expect(
      toConversationMessage(message({ priority: 'whenever' }), names).priority
    ).toBeUndefined();
    expect(toConversationMessage(message({ priority: 'urgent' }), names).priority).toBe('urgent');
  });
});

describe('plainPreview', () => {
  it('keeps the words and drops the markdown around them', () => {
    expect(plainPreview('## Round 2\n\n**approve** — see [the diff](https://example.com/d)')).toBe(
      'Round 2 approve — see the diff'
    );
    expect(plainPreview('> quoted `code` and _emphasis_.')).toBe('quoted code and emphasis.');
  });

  it('leaves snake_case and paths alone', () => {
    expect(plainPreview('set thread_key on inbox_thread_messages')).toBe(
      'set thread_key on inbox_thread_messages'
    );
    expect(plainPreview('2 * 3 = 6')).toBe('2 * 3 = 6');
  });
});
