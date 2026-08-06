import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createLoCoMoRunState,
  createLoCoMoSeedState,
  loadLoCoMoRunState,
  loadLoCoMoSeedState,
  writeLoCoMoRunState,
  writeLoCoMoSeedState,
} from './benchmark-locomo.state';

describe('LoCoMo benchmark state', () => {
  it('persists resumable seed and recall state atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'locomo-state-'));
    const seedPath = join(directory, 'seed.json');
    const runPath = join(directory, 'run.json');
    const seed = createLoCoMoSeedState({
      seedId: 'seed-1',
      datasetSource: 'file:locomo.json',
      datasetSha256: 'abc',
      representation: 'turn',
      semanticIndex: 'memory-chunks',
      embeddingConfigKey: 'ollama-model',
      userId: 'user-1',
      agentId: 'lumen',
    });
    seed.documents['conv-1/turn-D1:1'] = {
      documentId: 'conv-1/turn-D1:1',
      sampleId: 'conv-1',
      memoryId: 'memory-1',
      topic: 'benchmark:locomo:seed-1:conv-1',
      contentSha256: 'def',
      contentCharacters: 100,
      embeddingReady: true,
      embeddingChunkCount: 1,
      seedMs: 25,
    };
    const run = createLoCoMoRunState({
      runId: 'run-1',
      seedId: 'seed-1',
      datasetSha256: 'abc',
      representation: 'turn',
      topKs: [1, 5, 10],
      sampleIds: ['conv-1'],
      questionLimit: null,
      userId: 'user-1',
      agentId: 'lumen',
    });

    await writeLoCoMoSeedState(seedPath, seed);
    await writeLoCoMoRunState(runPath, run);

    expect((await loadLoCoMoSeedState(seedPath))?.documents).toHaveProperty('conv-1/turn-D1:1');
    expect((await loadLoCoMoRunState(runPath))?.completedQuestions).toEqual({});
    expect(JSON.parse(await readFile(seedPath, 'utf-8')).version).toBe(1);
  });

  it('returns null for missing state files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'locomo-state-'));
    expect(await loadLoCoMoSeedState(join(directory, 'missing.json'))).toBeNull();
    expect(await loadLoCoMoRunState(join(directory, 'missing-run.json'))).toBeNull();
  });
});
