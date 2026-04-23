import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLoCoMoDataset } from './locomo-loader';

describe('loadLoCoMoDataset', () => {
  const oldPath = process.env.LOCOMO_DATASET_PATH;
  const oldLimit = process.env.LOCOMO_LIMIT;
  const oldDistractors = process.env.LOCOMO_MAX_DISTRACTORS;

  beforeEach(() => {
    if (oldPath === undefined) delete process.env.LOCOMO_DATASET_PATH;
    else process.env.LOCOMO_DATASET_PATH = oldPath;
    if (oldLimit === undefined) delete process.env.LOCOMO_LIMIT;
    else process.env.LOCOMO_LIMIT = oldLimit;
    if (oldDistractors === undefined) delete process.env.LOCOMO_MAX_DISTRACTORS;
    else process.env.LOCOMO_MAX_DISTRACTORS = oldDistractors;
  });

  it('maps QA evidence sessions to target content and other sessions to distractors', async () => {
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
              { speaker: 'Alex', dia_id: 'D1:1', text: 'I started learning guitar last week.' },
              { speaker: 'Sam', dia_id: 'D1:2', text: 'That is exciting.' },
            ],
            session_2_date_time: '2024-01-02',
            session_2: [
              { speaker: 'Sam', dia_id: 'D2:1', text: 'Did you keep practicing?' },
              { speaker: 'Alex', dia_id: 'D2:2', text: 'Yes, I practiced every day.' },
            ],
          },
          qa: [
            {
              question: 'What instrument did Alex start learning?',
              answer: 'guitar',
              evidence: ['D1:1'],
              category: 1,
            },
          ],
        },
      ]),
      'utf-8'
    );

    process.env.LOCOMO_DATASET_PATH = file;
    process.env.LOCOMO_LIMIT = '10';
    process.env.LOCOMO_MAX_DISTRACTORS = '3';

    const loaded = await loadLoCoMoDataset();

    expect(loaded.cases).toHaveLength(1);
    expect(loaded.cases[0].id).toBe('sample-1-qa-1');
    expect(loaded.cases[0].query).toContain('instrument');
    expect(loaded.cases[0].targetContent).toContain('session_1');
    expect(loaded.cases[0].targetContent).toContain('[evidence] Alex: I started learning guitar');
    expect(loaded.cases[0].distractors).toHaveLength(1);
    expect(loaded.cases[0].distractors[0]).toContain('session_2');
    expect(loaded.cases[0].provenance).toContain('locomo:sample-1');
  });
});
