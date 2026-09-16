import { describe, expect, it } from 'vitest';
import { describeBackfillScope } from './backfill-memory-scope';

describe('backfill scope logging', () => {
  it('reports selection without exposing identifiers, topics, or control characters', () => {
    const filters = {
      sbSlug: 'synthetic-agent',
      memoryId: 'synthetic-memory',
      topic: 'invented-private-topic\nforged log line',
    };
    const summary = describeBackfillScope(filters);
    expect(summary).toBe('user=scoped agentFiltered=true memoryFiltered=true topicFiltered=true');
    for (const value of Object.values(filters)) expect(summary).not.toContain(value);
    expect(summary).not.toContain('\n');
  });

  it('distinguishes absent filters from active filters', () => {
    expect(describeBackfillScope({})).toBe(
      'user=scoped agentFiltered=false memoryFiltered=false topicFiltered=false'
    );
    expect(describeBackfillScope({ sbSlug: '', topic: 'invented-topic' })).toBe(
      'user=scoped agentFiltered=false memoryFiltered=false topicFiltered=true'
    );
  });
});
