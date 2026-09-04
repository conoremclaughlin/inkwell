import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MemorySemanticIndex } from '@inklabs/api/benchmarks';
import type { LoCoMoRepresentation } from './benchmark-data/locomo-loader';
import type { LoCoMoQuestionRun } from './benchmark-locomo.logic';

export type LoCoMoPhase = 'seed' | 'recall' | 'all';

export interface LoCoMoSeededDocument {
  documentId: string;
  sampleId: string;
  memoryId: string;
  topic: string;
  contentSha256: string;
  contentCharacters: number;
  embeddingReady: boolean;
  embeddingChunkCount: number;
  seedMs: number;
}

export interface LoCoMoSeedState {
  version: 1;
  seedId: string;
  datasetSource: string;
  datasetSha256: string;
  representation: LoCoMoRepresentation;
  embeddingConfigKey: string;
  userId: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  documents: Record<string, LoCoMoSeededDocument>;
}

export interface LoCoMoRunState {
  version: 1;
  runId: string;
  seedId: string;
  datasetSha256: string;
  representation: LoCoMoRepresentation;
  recallMode: 'semantic';
  semanticIndex: Exclude<MemorySemanticIndex, 'runtime-configured'>;
  semanticChunkTypes: ['content'];
  topKs: number[];
  sampleIds: string[];
  questionLimit: number | null;
  userId: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  completedQuestions: Record<string, LoCoMoQuestionRun>;
}

async function loadJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf-8');
  await rename(temporaryPath, path);
}

export function createLoCoMoSeedState(params: {
  seedId: string;
  datasetSource: string;
  datasetSha256: string;
  representation: LoCoMoRepresentation;
  embeddingConfigKey: string;
  userId: string;
  agentId: string;
}): LoCoMoSeedState {
  const now = new Date().toISOString();
  return {
    version: 1,
    ...params,
    createdAt: now,
    updatedAt: now,
    documents: {},
  };
}

export function createLoCoMoRunState(params: {
  runId: string;
  seedId: string;
  datasetSha256: string;
  representation: LoCoMoRepresentation;
  semanticIndex: Exclude<MemorySemanticIndex, 'runtime-configured'>;
  topKs: number[];
  sampleIds: string[];
  questionLimit: number | null;
  userId: string;
  agentId: string;
}): LoCoMoRunState {
  const now = new Date().toISOString();
  return {
    version: 1,
    ...params,
    recallMode: 'semantic',
    semanticChunkTypes: ['content'],
    createdAt: now,
    updatedAt: now,
    completedQuestions: {},
  };
}

export function loadLoCoMoSeedState(path: string): Promise<LoCoMoSeedState | null> {
  return loadJson<LoCoMoSeedState>(path);
}

export function loadLoCoMoRunState(path: string): Promise<LoCoMoRunState | null> {
  return loadJson<LoCoMoRunState>(path);
}

export async function writeLoCoMoSeedState(path: string, state: LoCoMoSeedState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path, state);
}

export async function writeLoCoMoRunState(path: string, state: LoCoMoRunState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path, state);
}
