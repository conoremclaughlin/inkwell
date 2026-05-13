import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createInitialBenchmarkSeedState,
  createInitialBenchmarkRunState,
  estimateRemainingDuration,
  formatDurationMs,
  loadBenchmarkRunState,
  loadBenchmarkSeedState,
} from './benchmark-memory-recall.state';

describe('benchmark-memory-recall state helpers', () => {
  it('creates an empty initial state', () => {
    const state = createInitialBenchmarkRunState({
      runId: 'membench-test',
      seedId: 'seed-test',
      dataset: 'longmemeval-s-cleaned',
      datasetSource: 'url:test',
      benchmarkFamily: 'longmemeval',
      variant: 'default',
      userId: 'user-123',
      modes: ['text', 'semantic', 'hybrid'],
      outputPath: '/tmp/out.json',
    });

    expect(state.runId).toBe('membench-test');
    expect(state.seedId).toBe('seed-test');
    expect(state.seededCases).toEqual({});
    expect(state.completedRuns).toEqual({});
    expect(state.timings).toEqual({
      seedCaseCount: 0,
      seedTotalMs: 0,
      recallCaseCount: 0,
      recallTotalMs: 0,
    });
  });

  it('creates an empty initial seed state', () => {
    const state = createInitialBenchmarkSeedState({
      seedId: 'seed-test',
      dataset: 'longmemeval-s-cleaned',
      datasetSource: 'url:test',
      benchmarkFamily: 'longmemeval',
      userId: 'user-123',
      representationKey: 'chunked-default',
    });

    expect(state.seedId).toBe('seed-test');
    expect(state.representationKey).toBe('chunked-default');
    expect(state.seededCases).toEqual({});
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
    expect(state?.seedId).toBe('legacy');
    expect(state?.seededCases.caseA.targetMemoryIds).toEqual(['memory-1']);
  });

  it('loads benchmark seed state with legacy singular targetMemoryId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'membench-seed-'));
    const file = join(dir, 'seed.json');
    await writeFile(
      file,
      JSON.stringify({
        seedId: 'seed-legacy',
        dataset: 'longmemeval-s-cleaned',
        datasetSource: 'url:test',
        benchmarkFamily: 'longmemeval',
        userId: 'user-123',
        representationKey: 'chunked-default',
        seededCases: {
          caseA: {
            caseId: 'caseA',
            topic: 'benchmark:caseA',
            targetMemoryId: 'memory-1',
            distractorMemoryIds: ['memory-2'],
            seedMs: 100,
          },
        },
        timings: {
          seedCaseCount: 1,
          seedTotalMs: 100,
          recallCaseCount: 0,
          recallTotalMs: 0,
        },
      }),
      'utf-8'
    );

    const state = await loadBenchmarkSeedState(file);
    expect(state?.seededCases.caseA.targetMemoryIds).toEqual(['memory-1']);
  });
});
