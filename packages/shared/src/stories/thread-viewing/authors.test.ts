import { describe, expect, it } from 'vitest';
import type { ThreadMessage } from '../threads-api/index.js';
import { nameLookup, toConversationMessage } from './authors.js';

const names = nameLookup([
  { sbSlug: 'wren', name: 'Wren' },
  { sbSlug: 'lumen', name: '  ' },
]);

const message = (over: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: 'm1',
  senderKind: 'sb',
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

  it('reads the viewer’s own reply as theirs', () => {
    const author = toConversationMessage(
      message({ senderKind: 'user', senderSlug: 'user', senderUserId: 'u1', isOwn: true }),
      names
    ).author;
    expect(author).toMatchObject({ kind: 'user', name: 'You', isOwn: true });
  });

  it('turns system events into event rows without a label', () => {
    const event = toConversationMessage(
      message({
        senderKind: 'system',
        senderSlug: 'system',
        messageType: 'system',
        content: 'Thread closed by wren',
      }),
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

  it('names another person as the server does, as a different author per person', () => {
    const sam = toConversationMessage(
      message({ senderKind: 'user', senderSlug: 'user', senderUserId: 'u2', senderName: 'Sam' }),
      names
    ).author;
    const kim = toConversationMessage(
      message({ senderKind: 'user', senderSlug: 'user', senderUserId: 'u3', senderName: 'Kim' }),
      names
    ).author;
    expect(sam).toMatchObject({ kind: 'user', name: 'Sam', isOwn: false });
    // Distinct ids, so the timeline never groups two people under one header.
    expect(sam.id).not.toBe(kim.id);
  });

  it('names a person the server could not name as a person, never "You" to a stranger', () => {
    const author = toConversationMessage(
      message({
        senderKind: 'user',
        senderSlug: 'user',
        senderUserId: 'u2',
        senderName: undefined,
      }),
      names
    ).author;
    expect(author).toMatchObject({ kind: 'user', name: 'a workspace member', isOwn: false });
  });

  it('ignores the retired metadata hint that once marked a person’s reply', () => {
    expect(
      toConversationMessage(message({ metadata: { sentBy: 'user' } }), names).author
    ).toMatchObject({ kind: 'sb', id: 'wren', name: 'Wren', isOwn: false });
  });

  it('drops a priority it does not recognise instead of passing it through', () => {
    expect(
      toConversationMessage(message({ priority: 'whenever' }), names).priority
    ).toBeUndefined();
    expect(toConversationMessage(message({ priority: 'urgent' }), names).priority).toBe('urgent');
  });
});
