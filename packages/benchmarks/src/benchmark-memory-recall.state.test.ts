import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createInitialBenchmarkRunState,
  estimateRemainingDuration,
  formatDurationMs,
  loadBenchmarkRunState,
} from './benchmark-memory-recall.state';

describe('benchmark-memory-recall state helpers', () => {
  it('creates an empty initial state', () => {
    const state = createInitialBenchmarkRunState({
      runId: 'membench-test',
      dataset: 'longmemeval-s-cleaned',
      datasetSource: 'url:test',
      benchmarkFamily: 'longmemeval',
      variant: 'default',
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

  it('normalizes legacy seeded state with singular targetMemoryId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'membench-state-'));
    const file = join(dir, 'state.json');
    await writeFile(
      file,
      JSON.stringify({
        runId: 'legacy',
        dataset: 'longmemeval-s-cleaned',
        datasetSource: 'url:test',
        benchmarkFamily: 'longmemeval',
        userId: 'user-123',
        modes: ['semantic'],
        outputPath: '/tmp/out.json',
        seededCases: {
          caseA: {
            caseId: 'caseA',
            topic: 'benchmark:caseA',
            targetMemoryId: 'memory-1',
            distractorMemoryIds: ['memory-2'],
            seedMs: 100,
          },
        },
        completedRuns: {},
        timings: {
          seedCaseCount: 1,
          seedTotalMs: 100,
          recallCaseCount: 0,
          recallTotalMs: 0,
        },
      }),
      'utf-8'
    );

    const state = await loadBenchmarkRunState(file);
    expect(state?.variant).toBe('default');
    expect(state?.seededCases.caseA.targetMemoryIds).toEqual(['memory-1']);
  });
});
