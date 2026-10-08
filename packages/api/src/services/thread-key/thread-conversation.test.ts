/**
 * A retained message from a deleted account, as the thread list shows it
 * (ink://specs/account-deletion, Q-A). Lumen's label probe from the #783 r1
 * review, kept as a regression: r2 added the reader with no test of its own.
 */

import { describe, expect, it } from 'vitest';
import {
  DELETED_ACCOUNT_SENDER_NAME,
  senderNameOfKind,
  toLastMessage,
} from './thread-conversation';

describe('a deleted account in the thread list', () => {
  it('keeps the kind and reads "Deleted account", not system, with no person looked up', () => {
    const last = toLastMessage(
      [
        {
          id: 'synthetic-message',
          sender_kind: 'deleted_account',
          sender_agent_id: null,
          sender_user_id: null,
          content: 'An ordinary retained opinion',
          message_type: 'message',
          created_at: '2026-10-07T12:00:00Z',
        },
      ],
      () => {
        throw new Error('No living author to look up');
      }
    );
    expect(last).toMatchObject({
      senderKind: 'deleted_account',
      senderName: DELETED_ACCOUNT_SENDER_NAME,
      isOwn: false,
    });
    expect(DELETED_ACCOUNT_SENDER_NAME).toBe('Deleted account');
  });

  it('names each kind that is not a person', () => {
    expect(senderNameOfKind('deleted_account', null)).toBe('Deleted account');
    expect(senderNameOfKind('sb', 'wren')).toBe('wren');
    expect(senderNameOfKind('sb', null)).toBe('an SB');
    expect(senderNameOfKind('system', null)).toBe('system');
  });
});
