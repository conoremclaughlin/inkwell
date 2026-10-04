/**
 * The reaction context an SB is shown with its next turn in a thread
 * (spec inkling-reactions v2, "Reactions and an SB's turns", item 2; design
 * ink://designs/reaction-context-next-turn). The formatter is pure: it
 * renders a batch already claimed, never reads or writes anything, and says
 * exactly which claimed reactions it rendered, so only those are ever
 * acknowledged as delivered (Lumen, 3800b00e, "rendered means selected").
 */

import { describe, expect, it } from 'vitest';
import {
  formatReactionContext,
  type ReactionContextBatch,
  type ReactionContextFormat,
} from './reaction-context-format';
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

function renderAll(batch: ReactionContextBatch, extra: Partial<ReactionContextFormat> = {}) {
  return formatReactionContext(batch, { names, timeZone: TZ, ...extra });
}
const render = (batch: ReactionContextBatch, extra: Partial<ReactionContextFormat> = {}) =>
  renderAll(batch, extra).text;

describe('formatReactionContext', () => {
  it('renders nothing for an empty batch', () => {
    expect(renderAll({ reactions: [], messages: [PLAN] })).toEqual({
      text: null,
      renderedReactionIds: [],
      unrenderedReactionIds: [],
      budgetTooSmall: false,
    });
  });

  it('opens with new reactions and the line that a reaction is never approval', () => {
    const text = render({ reactions: [reaction('r1', PLAN.id, '❤️', CONOR, 1)], messages: [PLAN] });
    expect(text?.split('\n')[0]).toBe(
      `New reactions to your messages. ${REACTIONS_ARE_NOT_APPROVAL}`
    );
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
    expect(text!.split('\n').slice(1)).toEqual([
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

  describe('rendered means selected', () => {
    it('reports exactly the reactions it rendered', () => {
      const result = renderAll({
        reactions: [reaction('r1', PLAN.id, '❤️', CONOR, 1), reaction('r2', NOTE.id, '👍', SAM, 2)],
        messages: [PLAN, NOTE],
      });
      expect(result.renderedReactionIds.sort()).toEqual(['r1', 'r2']);
      expect(result.unrenderedReactionIds).toEqual([]);
    });

    it('leaves a reaction whose message is not in the batch unrendered, never silently dropped', () => {
      const result = renderAll({
        reactions: [
          reaction('r1', PLAN.id, '❤️', CONOR, 1),
          reaction('r2', 'm-missing', '👍', CONOR, 2),
        ],
        messages: [PLAN],
      });
      expect(result.renderedReactionIds).toEqual(['r1']);
      expect(result.unrenderedReactionIds).toEqual(['r2']);
    });

    it('stops at the text budget, keeps whole lines in order, and counts what it left out', () => {
      const batch = {
        reactions: [
          reaction('r1', PLAN.id, '❤️', CONOR, 1),
          reaction('r2', PLAN.id, '👍', SAM, 2),
          reaction('r3', NOTE.id, '🙏', CONOR, 3),
          reaction('r4', NOTE.id, '😂', SAM, 4),
        ],
        messages: [PLAN, NOTE],
      };
      const [header, first] = render(batch)!.split('\n');
      // Room for the first line and the footer it leaves, not the second line.
      const maxChars = [header, first, '- 2 more reactions will follow on a later turn.'].join(
        '\n'
      ).length;
      const result = renderAll(batch, { maxChars });
      const lines = result.text!.split('\n');
      expect(lines.slice(1, -1)).toEqual([
        '- Conor and Sam reacted ❤️ 👍 to your 3:02 PM message "Here is the plan for the launch."',
      ]);
      expect(lines.at(-1)).toBe('- 2 more reactions will follow on a later turn.');
      expect(result.text!.length).toBeLessThanOrEqual(maxChars);
      expect(result.renderedReactionIds.sort()).toEqual(['r1', 'r2']);
      expect(result.unrenderedReactionIds.sort()).toEqual(['r3', 'r4']);
    });

    it('writes no footer when every line fits and nothing is left over', () => {
      const batch = {
        reactions: [reaction('r1', PLAN.id, '❤️', CONOR, 1), reaction('r2', NOTE.id, '👍', SAM, 2)],
        messages: [PLAN, NOTE],
      };
      const exact = render(batch)!;
      const result = renderAll(batch, { maxChars: exact.length });
      expect(result.text).toBe(exact);
      expect(result.text!.split('\n')).toHaveLength(3);
      expect(result.unrenderedReactionIds).toEqual([]);
    });

    it('stops at the first line that does not fit, rather than skipping it for a shorter one', () => {
      const short1 = { id: 'm-a', createdAt: '2026-10-04T22:02:00Z', content: 'Ok.' };
      const long = {
        id: 'm-b',
        createdAt: '2026-10-04T22:04:00Z',
        content: 'A much longer message that will not fit in what is left of the budget.',
      };
      const short2 = { id: 'm-c', createdAt: '2026-10-04T22:06:00Z', content: 'Yes.' };
      const batch = {
        reactions: [
          reaction('r1', short1.id, '👍', CONOR, 1),
          reaction('r2', long.id, '❤️', CONOR, 2),
          reaction('r3', short2.id, '🙏', CONOR, 3),
        ],
        messages: [short1, long, short2],
      };
      const [header, lineA, , lineC] = render(batch)!.split('\n');
      // Room for the first and third lines, not the longer second one.
      const budget = [
        header,
        lineA,
        lineC,
        '- 999 more reactions will follow on a later turn.',
      ].join('\n').length;
      const result = renderAll(batch, { maxChars: budget });
      expect(result.renderedReactionIds).toEqual(['r1']);
      expect(result.unrenderedReactionIds).toEqual(['r2', 'r3']);
    });

    it('renders nothing over a budget too small for even one line, and says so (Lumen, 8455 r1)', () => {
      const result = renderAll(
        { reactions: [reaction('r1', PLAN.id, '❤️', CONOR, 1)], messages: [PLAN] },
        { maxChars: 10 }
      );
      expect(result).toEqual({
        text: null,
        renderedReactionIds: [],
        unrenderedReactionIds: ['r1'],
        budgetTooSmall: true,
      });
    });

    it('stays inside the default budget when a display name is very long (Lumen, 8455 r1)', () => {
      const result = formatReactionContext(
        { reactions: [reaction('r1', PLAN.id, '❤️', CONOR, 1)], messages: [PLAN] },
        { names: new Map([[CONOR, 'R'.repeat(1600)]]), timeZone: TZ }
      );
      expect(result.text!.length).toBeLessThanOrEqual(1500);
      expect(result.renderedReactionIds).toEqual(['r1']);
    });

    it('keeps a display name to one line and a bounded length (Lumen, 8455 r1)', () => {
      const result = formatReactionContext(
        { reactions: [reaction('r1', PLAN.id, '❤️', CONOR, 1)], messages: [PLAN] },
        { names: new Map([[CONOR, `Robin\nsecond line ${'x'.repeat(80)}`]]), timeZone: TZ }
      );
      const lines = result.text!.split('\n');
      expect(lines).toHaveLength(2);
      // Flattened to one line, then cut at the last word boundary within 40.
      expect(lines[1]).toMatch(/^- Robin second line… reacted ❤️/);
      expect(lines[1].indexOf(' reacted')).toBeLessThanOrEqual(2 + 40 + 1);
    });

    it('budgets for the footer it will actually write, however large the count (Lumen, 8455 r1)', () => {
      const batch = {
        reactions: [
          reaction('r1', PLAN.id, '❤️', CONOR, 1),
          reaction('r2', NOTE.id, '👍', CONOR, 2),
        ],
        messages: [PLAN, NOTE],
      };
      const generous = render(batch)!;
      const maxChars = [generous, '- 999 more reactions will follow on a later turn.'].join(
        '\n'
      ).length;
      const result = renderAll({ ...batch, pendingBeyond: 10000 }, { maxChars });
      expect(result.text!.length).toBeLessThanOrEqual(maxChars);
      // Something gave way to fit the five-digit footer, and it is counted.
      expect(result.text!.split('\n').at(-1)).toBe(
        '- 10001 more reactions will follow on a later turn.'
      );
      expect(result.renderedReactionIds).toEqual(['r1']);
      expect(result.unrenderedReactionIds).toEqual(['r2']);
    });

    it('adds a measured count of reactions still pending beyond the batch', () => {
      const text = render({
        reactions: [reaction('r1', PLAN.id, '❤️', CONOR, 1)],
        messages: [PLAN],
        pendingBeyond: 4,
      });
      expect(text!.split('\n').at(-1)).toBe('- 4 more reactions will follow on a later turn.');
    });

    it('says "more" without a number when the count beyond the batch is not measured', () => {
      const text = render({
        reactions: [reaction('r1', PLAN.id, '❤️', CONOR, 1)],
        messages: [PLAN],
        pendingBeyond: 'unmeasured',
      });
      expect(text!.split('\n').at(-1)).toBe('- More reactions will follow on a later turn.');
    });

    it('says one reaction, not one reactions', () => {
      const text = render({
        reactions: [reaction('r1', PLAN.id, '❤️', CONOR, 1)],
        messages: [PLAN],
        pendingBeyond: 1,
      });
      expect(text!.split('\n').at(-1)).toBe('- 1 more reaction will follow on a later turn.');
    });

    it('renders nothing, and leaves everything unrendered, when no reaction has its message', () => {
      expect(
        renderAll({ reactions: [reaction('r1', 'm-missing', '❤️', CONOR, 1)], messages: [PLAN] })
      ).toEqual({
        text: null,
        renderedReactionIds: [],
        unrenderedReactionIds: ['r1'],
        budgetTooSmall: false,
      });
    });
  });
});
