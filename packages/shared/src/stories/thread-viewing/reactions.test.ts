import { describe, expect, it } from 'vitest';
import type { ThreadMessage } from '../threads-api/index.js';
import { toConversationMessage } from './authors.js';
import {
  REACTION_CHOICES,
  canAddReaction,
  reactionChipLabel,
  reactionChoiceLabel,
  reactionToggle,
  withReactionOverrides,
} from './reactions.js';

const message = (extra: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: 'm1',
  senderKind: 'sb',
  senderSlug: 'wren',
  content: 'hi',
  messageType: 'message',
  priority: 'normal',
  createdAt: '2026-10-04T00:00:00Z',
  ...extra,
});
const mine = (emoji: string) => ({ emoji, count: 1, mine: true });
const theirs = (emoji: string) => ({ emoji, count: 1, mine: false });

describe('reactions on a conversation message', () => {
  it('maps the server’s reactions, [] included, and keeps “the server can’t say” undefined', () => {
    const reactions = [{ emoji: '❤️', count: 2, reactors: [], mine: true }];
    expect(toConversationMessage(message({ reactions }), (s) => s).reactions).toEqual([
      { emoji: '❤️', count: 2, mine: true },
    ]);
    expect(toConversationMessage(message({ reactions: [] }), (s) => s).reactions).toEqual([]);
    expect(toConversationMessage(message(), (s) => s)).not.toHaveProperty('reactions');
  });

  it('labels a chip for a screen reader, saying when the viewer is among them', () => {
    expect(reactionChipLabel({ emoji: '❤️', count: 2, mine: true })).toBe('❤️, 2, including you');
    expect(reactionChipLabel({ emoji: '👍', count: 1, mine: false })).toBe('👍, 1');
  });

  it('offers the six contract choices, each with a name', () => {
    expect(REACTION_CHOICES.map((c) => c.emoji)).toEqual(['❤️', '👍', '😂', '😮', '😢', '🙏']);
    expect(reactionChoiceLabel(REACTION_CHOICES[0])).toBe('React with heart');
  });

  it('takes a reaction back when it is the viewer’s, adds it otherwise', () => {
    expect(reactionToggle('❤️', [mine('❤️')])).toEqual({ emoji: '❤️', remove: true });
    expect(reactionToggle('❤️', [theirs('❤️')])).toEqual({ emoji: '❤️', remove: false });
    expect(reactionToggle('❤️', undefined)).toEqual({ emoji: '❤️', remove: false });
  });

  it('lets the viewer add a seventh emoji to nobody’s list but their own taps back', () => {
    const six = ['❤️', '👍', '😂', '😮', '😢', '🙏'].map(mine);
    expect(canAddReaction('🎉', six)).toBe(false);
    expect(canAddReaction('❤️', six)).toBe(true);
    expect(canAddReaction('🎉', six.slice(0, 5))).toBe(true);
    // Other people's reactions don't count against the viewer.
    expect(canAddReaction('🎉', [...six.slice(0, 5), theirs('🎉')])).toBe(true);
  });

  it('overlays a request’s answer, but never invents reactions where the source has none', () => {
    const overrides = new Map([
      ['m1', [mine('👍')]],
      ['m2', [mine('👍')]],
    ]);
    const out = withReactionOverrides(
      [{ id: 'm1', reactions: [] }, { id: 'm2' }, { id: 'm3', reactions: [theirs('❤️')] }],
      overrides
    );
    expect(out).toEqual([
      { id: 'm1', reactions: [mine('👍')] },
      { id: 'm2' },
      { id: 'm3', reactions: [theirs('❤️')] },
    ]);
  });
});
