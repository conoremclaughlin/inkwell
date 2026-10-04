/**
 * The reaction context an SB is shown with its next turn in a thread
 * (spec inkling-reactions v2, "Reactions and an SB's turns", item 2; design
 * ink://designs/reaction-context-next-turn v2). The formatter is pure: it
 * renders a batch already claimed, and never reads or writes anything.
 */

import { describe, expect, it } from 'vitest';
import { formatReactionContext, type ReactionContextBatch } from './reaction-context-format';
import { REACTIONS_ARE_NOT_APPROVAL } from './thread-reactions';

const TZ = 'America/Los_Angeles';
const CONOR = 'u-conor';
const SAM = 'u-sam';
const ALEX = 'u-alex';
const names = new Map([
  [CONOR, 'Conor'],
  [SAM, 'Sam'],
  [ALEX, 'Alex'],
]);

// 2026-10-04 22:02Z is 3:02 PM in Los Angeles.
const PLAN = {
  id: 'm-plan',
  createdAt: '2026-10-04T22:02:00Z',
  content: 'Here is the plan for the launch.',
};
const NOTE = { id: 'm-note', createdAt: '2026-10-04T22:10:00Z', content: 'Done.' };

function reaction(
  id: string,
  messageId: string,
  emoji: string,
  reactorUserId: string,
  minute: number
) {
  return {
    id,
    messageId,
    emoji,
    reactorUserId,
    createdAt: `2026-10-04T22:${String(20 + minute).padStart(2, '0')}:00Z`,
  };
}

function render(batch: ReactionContextBatch) {
  return formatReactionContext(batch, { names, timeZone: TZ });
}

describe('formatReactionContext', () => {
  it('renders nothing for an empty batch', () => {
    expect(render({ reactions: [], messages: [PLAN] })).toBeNull();
  });

  it('opens with the line that a reaction is never approval', () => {
    const text = render({ reactions: [reaction('r1', PLAN.id, '❤️', CONOR, 1)], messages: [PLAN] });
    expect(text?.split('\n')[0]).toContain(REACTIONS_ARE_NOT_APPROVAL);
  });

  it('gives one line per message, however many reactions it has', () => {
    const text = render({
      reactions: [
        reaction('r1', PLAN.id, '❤️', CONOR, 1),
        reaction('r2', PLAN.id, '👍', CONOR, 2),
        reaction('r3', PLAN.id, '❤️', SAM, 3),
      ],
      messages: [PLAN],
    });
    const lines = text!.split('\n').slice(1);
    expect(lines).toEqual([
      '- Conor and Sam reacted ❤️ 👍 to your 3:02 PM message "Here is the plan for the launch."',
    ]);
  });

  it('counts three or more people instead of naming them', () => {
    const text = render({
      reactions: [
        reaction('r1', PLAN.id, '❤️', CONOR, 1),
        reaction('r2', PLAN.id, '❤️', SAM, 2),
        reaction('r3', PLAN.id, '😂', ALEX, 3),
      ],
      messages: [PLAN],
    });
    expect(text).toContain('- 3 people reacted ❤️ 😂 to your 3:02 PM message');
  });

  it('orders messages by their first reaction, and names someone unknown neutrally', () => {
    // m-plan sorts after m-note by id, and the reactions arrive newest first,
    // so only first-reaction order puts the plan first.
    const text = render({
      reactions: [
        reaction('r2', NOTE.id, '🙏', 'u-unknown', 2),
        reaction('r1', PLAN.id, '👍', CONOR, 1),
      ],
      messages: [NOTE, PLAN],
    });
    expect(text!.split('\n').slice(1)).toEqual([
      '- Conor reacted 👍 to your 3:02 PM message "Here is the plan for the launch."',
      '- Someone reacted 🙏 to your 3:10 PM message "Done."',
    ]);
  });

  it('shortens a long message to its first words, on one line', () => {
    const long = {
      id: 'm-long',
      createdAt: PLAN.createdAt,
      content:
        'A long message\nthat runs over several lines and keeps going well past the excerpt length.',
    };
    const text = render({ reactions: [reaction('r1', long.id, '😮', CONOR, 1)], messages: [long] });
    expect(text).toContain('message "A long message that runs over several…"');
  });

  it('dates a message from an earlier day than its reaction', () => {
    const yesterday = { id: 'm-old', createdAt: '2026-10-03T16:30:00Z', content: 'Morning.' };
    const text = render({
      reactions: [reaction('r1', yesterday.id, '❤️', CONOR, 1)],
      messages: [yesterday],
    });
    expect(text).toContain('to your Oct 3, 9:30 AM message "Morning."');
  });

  it('says when more reactions are waiting for a later turn', () => {
    const text = render({
      reactions: [reaction('r1', PLAN.id, '❤️', CONOR, 1)],
      messages: [PLAN],
      pendingBeyond: 4,
    });
    expect(text!.split('\n').at(-1)).toBe('- 4 more reactions will follow on a later turn.');
  });

  it('skips a reaction whose message is not in the batch', () => {
    expect(
      render({ reactions: [reaction('r1', 'm-missing', '❤️', CONOR, 1)], messages: [PLAN] })
    ).toBeNull();
  });
});
