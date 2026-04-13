import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLongMemEvalDataset } from './longmemeval-loader';

describe('loadLongMemEvalDataset', () => {
  const oldPath = process.env.LONGMEMEVAL_DATASET_PATH;
  const oldLimit = process.env.LONGMEMEVAL_LIMIT;
  const oldDistractors = process.env.LONGMEMEVAL_MAX_DISTRACTORS;

  beforeEach(() => {
    if (oldPath === undefined) delete process.env.LONGMEMEVAL_DATASET_PATH;
    else process.env.LONGMEMEVAL_DATASET_PATH = oldPath;
    if (oldLimit === undefined) delete process.env.LONGMEMEVAL_LIMIT;
    else process.env.LONGMEMEVAL_LIMIT = oldLimit;
    if (oldDistractors === undefined) delete process.env.LONGMEMEVAL_MAX_DISTRACTORS;
    else process.env.LONGMEMEVAL_MAX_DISTRACTORS = oldDistractors;
  });

  it('maps answer sessions to distinct target documents and non-answer sessions to distractors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'longmemeval-'));
    const file = join(dir, 'sample.json');
    await writeFile(
      file,
      JSON.stringify([
        {
          question_id: 'q1',
          question_type: 'multi-session',
          question: 'What database backend did the user settle on?',
          question_date: '2025-01-10',
          haystack_session_ids: ['s1', 's2', 's3'],
          answer_session_ids: ['s2', 's3'],
          haystack_sessions: [
            [
              { role: 'user', content: 'I am still deciding between sqlite and postgres.' },
              { role: 'assistant', content: 'Let us compare both options.' },
            ],
            [
              { role: 'user', content: 'I think postgres is the safer backend.' },
              { role: 'assistant', content: 'That sounds like the current preference.' },
            ],
            [{ role: 'user', content: 'Decision made: we are standardizing on postgres.' }],
          ],
        },
      ]),
      'utf-8'
    );

    process.env.LONGMEMEVAL_DATASET_PATH = file;
    process.env.LONGMEMEVAL_LIMIT = '10';
    process.env.LONGMEMEVAL_MAX_DISTRACTORS = '2';

    const loaded = await loadLongMemEvalDataset();

    expect(loaded.cases).toHaveLength(1);
    expect(loaded.cases[0].id).toBe('q1');
    expect(loaded.cases[0].query).toContain('What database backend');
    expect(loaded.cases[0].targetContents).toEqual([
      expect.stringContaining('session s2'),
      expect.stringContaining('session s3'),
    ]);
    expect(loaded.cases[0].distractors).toHaveLength(1);
    expect(loaded.cases[0].distractors[0]).toContain('session s1');
    expect(loaded.cases[0].provenance).toContain('multi-session');
  });

  it('uses the full haystack when LONGMEMEVAL_MAX_DISTRACTORS is not set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'longmemeval-full-'));
    const file = join(dir, 'sample-full.json');
    await writeFile(
      file,
      JSON.stringify([
        {
          question_id: 'q2',
          question_type: 'single-session-user',
          question: 'What city did I move to?',
          question_date: '2025-01-11',
          haystack_session_ids: ['s1', 's2', 's3', 's4'],
          answer_session_ids: ['s4'],
          haystack_sessions: [
            [{ role: 'user', content: 'This is distractor one.' }],
            [{ role: 'user', content: 'This is distractor two.' }],
            [{ role: 'user', content: 'This is distractor three.' }],
            [{ role: 'user', content: 'I moved to Portland last summer.' }],
          ],
        },
      ]),
      'utf-8'
    );

    process.env.LONGMEMEVAL_DATASET_PATH = file;
    process.env.LONGMEMEVAL_LIMIT = '10';
    delete process.env.LONGMEMEVAL_MAX_DISTRACTORS;

    const loaded = await loadLongMemEvalDataset();

    expect(loaded.cases).toHaveLength(1);
    expect(loaded.cases[0].distractors).toHaveLength(3);
    expect(loaded.cases[0].targetContents).toEqual([expect.stringContaining('session s4')]);
  });
});
