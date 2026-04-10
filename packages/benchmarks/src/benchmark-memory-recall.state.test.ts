import { describe, expect, it } from 'vitest';
import {
  createInitialBenchmarkRunState,
  estimateRemainingDuration,
  formatDurationMs,
} from './benchmark-memory-recall.state';

describe('benchmark-memory-recall state helpers', () => {
  it('creates an empty initial state', () => {
    const state = createInitialBenchmarkRunState({
      runId: 'membench-test',
      dataset: 'longmemeval-s-cleaned',
      datasetSource: 'url:test',
      benchmarkFamily: 'longmemeval',
      userId: 'user-123',
      modes: ['text', 'semantic', 'hybrid'],
      outputPath: '/tmp/out.json',
    });

    expect(state.runId).toBe('membench-test');
    expect(state.seededCases).toEqual({});
    expect(state.completedRuns).toEqual({});
    expect(state.timings).toEqual({
      seedCaseCount: 0,
      seedTotalMs: 0,
      recallCaseCount: 0,
      recallTotalMs: 0,
    });
  });

  it('formats durations for logs', () => {
    expect(formatDurationMs(250)).toBe('250ms');
    expect(formatDurationMs(1500)).toBe('1.5s');
    expect(formatDurationMs(65000)).toBe('1m 5s');
  });

  it('estimates remaining duration from average case time', () => {
    expect(
      estimateRemainingDuration({
        completed: 20,
        total: 100,
        averageMs: 2000,
      })
    ).toBe('2m 40s');
  });
});
