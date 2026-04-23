import { describe, expect, it } from 'vitest';
import {
  computeChronologyAwareBoost,
  extractDreamDurableFacts,
  findDreamDuplicateCandidates,
  findDreamSupersessionCandidates,
  queryHasChronologyIntent,
} from './memory-dreaming';

describe('memory-dreaming', () => {
  it('detects chronology intent in current-policy style queries', () => {
    expect(queryHasChronologyIntent('what is the current escalation policy?')).toBe(true);
    expect(queryHasChronologyIntent('find the latest override')).toBe(true);
    expect(queryHasChronologyIntent('who owns the notebook')).toBe(false);
  });

  it('boosts newer override memories when chronology intent is present', () => {
    const minCreatedAt = new Date('2026-03-01T00:00:00Z');
    const maxCreatedAt = new Date('2026-03-20T00:00:00Z');

    const olderBoost = computeChronologyAwareBoost({
      query: 'what is the current policy override',
      memory: {
        content: 'Older policy for wound-care escalation.',
        summary: 'Old escalation policy',
        topicKey: 'policy:wound-care',
        createdAt: minCreatedAt,
      },
      minCreatedAt,
      maxCreatedAt,
    });

    const newerBoost = computeChronologyAwareBoost({
      query: 'what is the current policy override',
      memory: {
        content: 'Current policy overrides the previous wound-care escalation steps.',
        summary: 'Current escalation policy',
        topicKey: 'policy:wound-care',
        createdAt: maxCreatedAt,
      },
      minCreatedAt,
      maxCreatedAt,
    });

    expect(newerBoost).toBeGreaterThan(olderBoost);
    expect(newerBoost).toBeGreaterThan(0);
  });

  it('extracts durable fact candidates from memory text', () => {
    const facts = extractDreamDurableFacts({
      summary: 'Current escalation policy',
      content:
        'The new wound-care escalation policy replaces the previous triage flow. It requires notifying the inpatient lead within 15 minutes because the older path is deprecated.',
    });

    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0]?.text.toLowerCase()).toContain('policy');
  });

  it('detects likely duplicate memories', () => {
    const duplicates = findDreamDuplicateCandidates([
      {
        id: 'mem-1',
        summary: 'Current escalation policy',
        content: 'Current escalation policy for wound-care requires inpatient lead notification.',
        topicKey: 'policy:wound-care',
      },
      {
        id: 'mem-2',
        summary: 'Current escalation policy',
        content: 'Current escalation policy for wound-care requires inpatient lead notification.',
        topicKey: 'policy:wound-care',
      },
    ]);

    expect(duplicates).toEqual([
      expect.objectContaining({
        canonicalId: 'mem-1',
        duplicateId: 'mem-2',
      }),
    ]);
  });

  it('detects likely supersession candidates within the same topic', () => {
    const supersessions = findDreamSupersessionCandidates([
      {
        id: 'mem-1',
        summary: 'Old escalation policy',
        content: 'Old escalation policy for wound-care uses the triage lead.',
        topicKey: 'policy:wound-care',
        createdAt: new Date('2026-03-01T00:00:00Z'),
      },
      {
        id: 'mem-2',
        summary: 'Current escalation policy',
        content:
          'Current escalation policy replaces the prior wound-care triage flow and now uses the inpatient lead.',
        topicKey: 'policy:wound-care',
        createdAt: new Date('2026-03-20T00:00:00Z'),
      },
    ]);

    expect(supersessions).toEqual([
      expect.objectContaining({
        newerId: 'mem-2',
        olderId: 'mem-1',
      }),
    ]);
  });
});
