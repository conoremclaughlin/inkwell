import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLoCoMoSourceDocuments,
  loadLoCoMoCorpus,
  loadLoCoMoDataset,
  normalizeLoCoMoEvidenceField,
} from './locomo-loader';

const ENV_KEYS = ['LOCOMO_DATASET_PATH', 'LOCOMO_LIMIT', 'LOCOMO_MAX_DISTRACTORS'] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

async function writeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'locomo-'));
  const file = join(dir, 'sample.json');

  await writeFile(
    file,
    JSON.stringify([
      {
        sample_id: 'sample-1',
        conversation: {
          speaker_a: 'Alex',
          speaker_b: 'Sam',
          session_1_date_time: '2024-01-01',
          session_1: [
            { speaker: 'Alex', dia_id: 'D1:1', text: 'I started learning guitar.' },
            { speaker: 'Sam', dia_id: 'D1:2', text: 'That is exciting.' },
          ],
          session_2_date_time: '2024-01-02',
          session_2: [
            { speaker: 'Sam', dia_id: 'D2:1', text: 'Did you keep practicing?' },
            { speaker: 'Alex', dia_id: 'D2:2', text: 'Yes, every day.' },
          ],
        },
        qa: [
          {
            question: 'What instrument did Alex start learning?',
            answer: 'guitar',
            evidence: ['D1:1'],
            category: 1,
          },
          {
            question: 'What happened across both sessions?',
            answer: 'Alex practiced guitar.',
            evidence: ['D1:1; D2:2'],
            category: 3,
          },
          {
            question: 'Was an unsupported event mentioned?',
            answer: 'No.',
            evidence: [],
            category: 5,
          },
        ],
      },
    ]),
    'utf-8'
  );

  return file;
}

describe('LoCoMo corpus loader', () => {
  it('normalizes only unambiguous evidence IDs', () => {
    expect(normalizeLoCoMoEvidenceField('D8:6; D9:17')).toEqual(['D8:6', 'D9:17']);
    expect(normalizeLoCoMoEvidenceField('D:11:26')).toEqual(['D11:26']);
    expect(normalizeLoCoMoEvidenceField('D30:05')).toEqual(['D30:5']);
    expect(normalizeLoCoMoEvidenceField('D')).toEqual([]);
  });

  it('loads a conversation once and keeps QA labels outside source documents', async () => {
    process.env.LOCOMO_DATASET_PATH = await writeFixture();

    const corpus = await loadLoCoMoCorpus();

    expect(corpus.audit).toMatchObject({
      samples: 1,
      sessions: 2,
      turns: 4,
      questions: 3,
      questionsWithoutEvidence: 1,
      questionsWithFullyResolvedEvidence: 2,
      repairedEvidenceFields: 1,
    });
    expect(corpus.datasetSha256).toMatch(/^[a-f0-9]{64}$/);

    const sample = corpus.samples[0];
    expect(sample.questions[1].evidenceIds).toEqual(['D1:1', 'D2:2']);

    const turnDocuments = buildLoCoMoSourceDocuments(sample, 'turn');
    expect(turnDocuments).toHaveLength(4);
    expect(turnDocuments[0]).toMatchObject({
      documentId: 'sample-1/turn-D1:1',
      diaId: 'D1:1',
      sessionNumber: 1,
    });
    expect(turnDocuments[0].content).toContain('Alex: I started learning guitar.');
    expect(turnDocuments[0].content).not.toContain('[evidence]');
    expect(turnDocuments[0].content).not.toContain('What instrument');

    const sessionDocuments = buildLoCoMoSourceDocuments(sample, 'session');
    expect(sessionDocuments).toHaveLength(2);
    expect(sessionDocuments[0].diaIds).toEqual(['D1:1', 'D1:2']);
    expect(sessionDocuments[0].content).toContain('Sam: That is exciting.');
    expect(sessionDocuments[0].content).not.toContain('[evidence]');
  });

  it('labels the old per-QA adapter as scientifically invalid and does not hide distractors', async () => {
    process.env.LOCOMO_DATASET_PATH = await writeFixture();
    process.env.LOCOMO_LIMIT = '1';

    const loaded = await loadLoCoMoDataset();

    expect(loaded.source).toContain('legacy-qa-duplicated');
    expect(loaded.cases).toHaveLength(1);
    expect(loaded.cases[0].targetContents).toHaveLength(1);
    expect(loaded.cases[0].distractors).toHaveLength(1);
    expect(loaded.cases[0].targetContents?.[0]).not.toContain('[evidence]');
  });
});
