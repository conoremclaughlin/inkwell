import { describe, expect, it } from 'vitest';
import { buildTimeline, type TimelineItem } from './timeline';
import type { ConversationAuthor, ConversationMessage } from './types';

// Local wall-clock times, so day boundaries mean the same thing wherever the
// suite runs.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).toISOString();
const NOW = new Date(2026, 8, 23, 18, 0);

const lumen: ConversationAuthor = { kind: 'sb', id: 'lumen', name: 'lumen', isOwn: false };
const wren: ConversationAuthor = { kind: 'sb', id: 'wren', name: 'wren', isOwn: false };
const you: ConversationAuthor = { kind: 'user', id: 'user', name: 'You', isOwn: true };
const system: ConversationAuthor = { kind: 'system', id: 'system', name: 'system', isOwn: false };

let seq = 0;
const msg = (author: ConversationAuthor, createdAt: string, body = 'hi'): ConversationMessage => ({
  id: `m${++seq}`,
  author,
  body,
  createdAt,
});

/** A compact picture of the timeline: "day:Today", "unread:2", "lumen", "+lumen". */
function shape(items: TimelineItem[]): string[] {
  return items.map((item) => {
    if (item.type === 'day') return `day:${item.label}`;
    if (item.type === 'unread') return `unread:${item.count}`;
    return `${item.continuation ? '+' : ''}${item.message.author.id}`;
  });
}

describe('buildTimeline', () => {
  it('groups one author’s consecutive messages under a single header', () => {
    const items = buildTimeline(
      [msg(lumen, at(23, 10, 0)), msg(lumen, at(23, 10, 2)), msg(wren, at(23, 10, 3))],
      { now: NOW }
    );
    expect(shape(items)).toEqual(['day:Today', 'lumen', '+lumen', 'wren']);
  });

  it('repeats the header after a pause longer than the group window', () => {
    const items = buildTimeline([msg(lumen, at(23, 10, 0)), msg(lumen, at(23, 10, 6))], {
      now: NOW,
    });
    expect(shape(items)).toEqual(['day:Today', 'lumen', 'lumen']);
  });

  it('starts a new day with a divider and a fresh header, even mid-group', () => {
    const items = buildTimeline([msg(lumen, at(22, 23, 58)), msg(lumen, at(23, 0, 1))], {
      now: NOW,
    });
    expect(shape(items)).toEqual(['day:Yesterday', 'lumen', 'day:Today', 'lumen']);
  });

  it('never folds a system event into a group, or a message into one', () => {
    const items = buildTimeline(
      [msg(lumen, at(23, 10, 0)), msg(system, at(23, 10, 1)), msg(lumen, at(23, 10, 2))],
      { now: NOW }
    );
    expect(shape(items)).toEqual(['day:Today', 'lumen', 'system', 'lumen']);
  });

  it('gives a labelled message (task request, notification) its own header', () => {
    const request = { ...msg(lumen, at(23, 10, 1)), label: 'task_request' };
    const items = buildTimeline([msg(lumen, at(23, 10, 0)), request, msg(lumen, at(23, 10, 2))], {
      now: NOW,
    });
    expect(shape(items)).toEqual(['day:Today', 'lumen', 'lumen', '+lumen']);
  });

  it('orders by time whatever order the source delivered', () => {
    const late = msg(wren, at(23, 11));
    const early = msg(lumen, at(23, 9));
    expect(shape(buildTimeline([late, early], { now: NOW }))).toEqual([
      'day:Today',
      'lumen',
      'wren',
    ]);
  });

  describe('the new-messages divider', () => {
    it('sits before the first message newer than the cursor and counts what follows', () => {
      const items = buildTimeline(
        [
          msg(lumen, at(23, 9)),
          msg(wren, at(23, 10)),
          msg(lumen, at(23, 11)),
          msg(lumen, at(23, 11, 1)),
        ],
        { unreadAfter: at(23, 9, 30), now: NOW }
      );
      expect(shape(items)).toEqual(['day:Today', 'lumen', 'unread:3', 'wren', 'lumen', '+lumen']);
    });

    it('breaks a group it lands inside, so the reader sees who is speaking', () => {
      const items = buildTimeline([msg(lumen, at(23, 10, 0)), msg(lumen, at(23, 10, 1))], {
        unreadAfter: at(23, 10, 0),
        now: NOW,
      });
      expect(shape(items)).toEqual(['day:Today', 'lumen', 'unread:1', 'lumen']);
    });

    it('skips the viewer’s own messages and system events when placing and counting', () => {
      const items = buildTimeline(
        [
          msg(lumen, at(23, 9)),
          msg(you, at(23, 10)),
          msg(system, at(23, 10, 30)),
          msg(wren, at(23, 11)),
        ],
        { unreadAfter: at(23, 9, 30), now: NOW }
      );
      expect(shape(items)).toEqual(['day:Today', 'lumen', 'user', 'system', 'unread:1', 'wren']);
    });

    it('is absent when everything is read, and when there is no cursor', () => {
      const messages = [msg(lumen, at(23, 9)), msg(wren, at(23, 10))];
      expect(shape(buildTimeline(messages, { unreadAfter: at(23, 12), now: NOW }))).not.toContain(
        'unread:0'
      );
      expect(
        buildTimeline(messages, { unreadAfter: at(23, 12), now: NOW }).some(
          (i) => i.type === 'unread'
        )
      ).toBe(false);
      expect(buildTimeline(messages, { now: NOW }).some((i) => i.type === 'unread')).toBe(false);
    });

    it('opens the whole window when the cursor predates every loaded message', () => {
      const items = buildTimeline([msg(lumen, at(23, 9)), msg(wren, at(23, 10))], {
        unreadAfter: at(20, 9),
        now: NOW,
      });
      expect(shape(items)).toEqual(['day:Today', 'unread:2', 'lumen', 'wren']);
    });
  });
});
