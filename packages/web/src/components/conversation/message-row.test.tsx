// @vitest-environment jsdom
/**
 * MessageRow and reactions (spec inkling-reactions): every kind of message
 * shows the reactions stored on it, and a member can toggle them. A system
 * event is a stored message like any other (Lumen, #742 r1).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ConversationMessage } from '@inklabs/shared/stories/thread-viewing';
import { MessageRow } from './message-row';

afterEach(cleanup);

const messageBy = (kind: 'sb' | 'system'): ConversationMessage => ({
  id: 'fixture-message',
  author: { kind, id: 'fixture-author', name: 'Fixture', isOwn: false },
  body: 'Synthetic message.',
  createdAt: '2026-10-04T12:00:00Z',
  reactions: [{ emoji: '❤️', count: 1, mine: true }],
});

describe('MessageRow reactions', () => {
  it.each(['sb', 'system'] as const)(
    'shows a %s message’s reactions, and a tap toggles them on that message',
    (kind) => {
      const onReact = vi.fn();
      render(<MessageRow message={messageBy(kind)} onReact={onReact} />);
      fireEvent.click(screen.getByRole('button', { name: '❤️, 1, including you' }));
      expect(onReact).toHaveBeenCalledWith('fixture-message', '❤️');
      expect(screen.getByRole('button', { name: 'React' })).toBeTruthy();
    }
  );

  it.each(['sb', 'system'] as const)(
    'shows a %s message’s reactions read-only to a reader who is not in the thread',
    (kind) => {
      render(<MessageRow message={messageBy(kind)} />);
      expect(screen.getByRole('img', { name: '❤️, 1, including you' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'React' })).toBeNull();
    }
  );
});
