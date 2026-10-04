// @vitest-environment jsdom
/**
 * Reaction chips under a message (spec inkling-reactions): what a reader
 * hears, what a tap does, and what is offered only to a member.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactionChips } from './reaction-chips';

afterEach(cleanup);

const two = [
  { emoji: '❤️', count: 2, mine: true },
  { emoji: '👍', count: 1, mine: false },
];

describe('ReactionChips', () => {
  it('names each chip for a screen reader, and marks the viewer’s own as pressed', () => {
    render(<ReactionChips messageId="m1" reactions={two} onToggle={() => {}} />);
    const heart = screen.getByRole('button', { name: '❤️, 2, including you' });
    const thumbs = screen.getByRole('button', { name: '👍, 1' });
    expect(heart.getAttribute('aria-pressed')).toBe('true');
    expect(thumbs.getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles the tapped emoji on that message', () => {
    const onToggle = vi.fn();
    render(<ReactionChips messageId="m1" reactions={two} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: '👍, 1' }));
    expect(onToggle).toHaveBeenCalledWith('m1', '👍');
  });

  it('opens the six named choices from React, adds the one chosen, and closes', () => {
    const onToggle = vi.fn();
    render(<ReactionChips messageId="m1" reactions={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'React' }));
    const names = screen
      .getAllByRole('button', { name: /^React with / })
      .map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual([
      'React with heart',
      'React with thumbs up',
      'React with laughing',
      'React with surprised',
      'React with sad',
      'React with thanks',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'React with thanks' }));
    expect(onToggle).toHaveBeenCalledWith('m1', '🙏');
    expect(screen.queryByRole('group', { name: 'Choose a reaction' })).toBeNull();
  });

  it('opens the choices inside the chips’ own row, so they wrap with it (Lumen, #742 r1)', () => {
    // Anchored beside a trailing React button, the choices ran past the
    // conversation's right edge at 390px with three chips. In the row's own
    // flow they wrap to the next line instead. jsdom has no layout, so this
    // holds the structure; the width is measured in a browser.
    const three = [
      { emoji: '❤️', count: 2, mine: true },
      { emoji: '👍', count: 1, mine: false },
      { emoji: '😂', count: 1, mine: false },
    ];
    const { container } = render(
      <ReactionChips messageId="m1" reactions={three} onToggle={() => {}} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'React' }));
    const row = container.querySelector('[data-reactions-for="m1"]');
    const choices = screen.getByRole('group', { name: 'Choose a reaction' });
    expect(choices.parentElement).toBe(row);
    expect(row?.className).toContain('flex-wrap');
    expect(choices.className).not.toMatch(/\b(absolute|fixed)\b/);
    expect(choices.className).toContain('flex-wrap');
  });

  it('closes the choices on Escape', () => {
    render(<ReactionChips messageId="m1" reactions={[]} onToggle={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'React' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'React with heart' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Choose a reaction' })).toBeNull();
  });

  it('disables a seventh emoji of the viewer’s own, but not taking one back', () => {
    const six = ['❤️', '👍', '😂', '😮', '😢', '🎉'].map((emoji) => ({
      emoji,
      count: 1,
      mine: true,
    }));
    render(<ReactionChips messageId="m1" reactions={six} onToggle={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'React' }));
    expect(screen.getByRole('button', { name: 'React with thanks' })).toHaveProperty(
      'disabled',
      true
    );
    expect(screen.getByRole('button', { name: 'React with heart' })).toHaveProperty(
      'disabled',
      false
    );
  });

  it('shows a background thread’s reactions read-only, offering nothing', () => {
    render(<ReactionChips messageId="m1" reactions={two} />);
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.getByRole('img', { name: '❤️, 2, including you' })).toBeTruthy();
  });

  it('shows nothing when the source carries no reactions, or none to read', () => {
    const { container, rerender } = render(
      <ReactionChips messageId="m1" reactions={undefined} onToggle={() => {}} />
    );
    expect(container.innerHTML).toBe('');
    rerender(<ReactionChips messageId="m1" reactions={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
