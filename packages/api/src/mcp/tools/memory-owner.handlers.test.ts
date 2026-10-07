/**
 * The memory tools that address a memory by id act only for its owner when an
 * SB calls them, and keep a person's same-user reach
 * (ink://specs/remove-shared-memories §3.4).
 *
 * Through the real request context and owner resolver; the repository is a
 * spy, so these cases pin what each handler asks it for.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DataComposer } from '../../data/composer';
import { runWithRequestContext } from '../../utils/request-context';
import {
  handleForget,
  handleGetMemoryHistory,
  handleGetUserHistory,
  handleRecall,
  handleRestoreMemory,
  handleUpdateMemory,
} from './memory-handlers';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/user-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/user-resolver')>()),
  resolveUserOrThrow: vi.fn().mockResolvedValue({ user: { id: 'owner' }, resolvedBy: 'userId' }),
}));

const MYRA = '33333333-3333-4333-8333-333333333333';
const WREN = '44444444-4444-4444-8444-444444444444';
const MEMORY = '55555555-5555-4555-8555-555555555555';
const HISTORY = '66666666-6666-4666-8666-666666666666';

function fixture(memoryOwner: string | null) {
  const memory = {
    id: MEMORY,
    userId: 'owner',
    content: 'a fact',
    source: 'observation',
    salience: 'medium',
    topics: [],
    metadata: {},
    version: 1,
    createdAt: new Date(),
    ...(memoryOwner ? { sbId: memoryOwner, sbSlug: memoryOwner === MYRA ? 'myra' : 'wren' } : {}),
  };
  const repo = {
    getMemory: vi.fn().mockResolvedValue(memory),
    forget: vi.fn().mockResolvedValue(true),
    updateMemory: vi.fn().mockResolvedValue(memory),
    getMemoryHistory: vi.fn().mockResolvedValue([]),
    getUserMemoryHistory: vi.fn().mockResolvedValue([]),
    restoreMemory: vi.fn().mockResolvedValue(null),
    recallWithScores: vi.fn().mockResolvedValue([]),
  };
  const client = {
    from() {
      const q = {
        select: () => q,
        eq: () => q,
        then: (resolve: (r: unknown) => unknown) =>
          Promise.resolve({ data: [{ id: WREN, workspace_id: null }], error: null }).then(resolve),
      };
      return q;
    },
  };
  const composer = {
    getClient: () => client,
    repositories: { memory: repo },
  } as unknown as DataComposer;
  return { composer, repo };
}

const asMyra = <T>(fn: () => Promise<T>) =>
  runWithRequestContext(
    { userId: 'owner', agentTokenBound: true, tokenSlug: 'myra', tokenSbId: MYRA },
    fn
  );
const asPerson = <T>(fn: () => Promise<T>) => runWithRequestContext({ userId: 'owner' }, fn);
const parsed = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

afterEach(() => vi.clearAllMocks());

describe('id-addressed memory tools, by caller', () => {
  it("refuses an SB forgetting another SB's memory, and deletes nothing", async () => {
    const f = fixture(WREN);
    const result = await asMyra(() => handleForget({ memoryId: MEMORY }, f.composer));
    expect(parsed(result).success).toBe(false);
    expect(f.repo.forget).not.toHaveBeenCalled();
  });

  it('refuses an SB forgetting a memory with no owner', async () => {
    const f = fixture(null);
    const result = await asMyra(() => handleForget({ memoryId: MEMORY }, f.composer));
    expect(parsed(result).success).toBe(false);
    expect(f.repo.forget).not.toHaveBeenCalled();
  });

  it('lets an SB forget its own memory, confined to its identity', async () => {
    const f = fixture(MYRA);
    await asMyra(() => handleForget({ memoryId: MEMORY }, f.composer));
    expect(f.repo.forget).toHaveBeenCalledWith(MEMORY, 'owner', MYRA);
  });

  it('lets a person forget any of their memories without naming an SB', async () => {
    const f = fixture(WREN);
    await asPerson(() => handleForget({ memoryId: MEMORY }, f.composer));
    expect(f.repo.forget).toHaveBeenCalledWith(MEMORY, 'owner', undefined);
  });

  it("confines an SB's update, history and restore to its own identity", async () => {
    const f = fixture(MYRA);
    await asMyra(() => handleUpdateMemory({ memoryId: MEMORY, salience: 'high' }, f.composer));
    await asMyra(() => handleGetMemoryHistory({ memoryId: MEMORY }, f.composer));
    await asMyra(() => handleGetUserHistory({}, f.composer));
    await asMyra(() => handleRestoreMemory({ historyId: HISTORY }, f.composer));

    expect(f.repo.updateMemory.mock.calls[0]![3]).toBe(MYRA);
    expect(f.repo.getMemoryHistory).toHaveBeenCalledWith(MEMORY, 'owner', MYRA);
    expect(f.repo.getUserMemoryHistory).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({ ownerSbId: MYRA })
    );
    expect(f.repo.restoreMemory).toHaveBeenCalledWith(HISTORY, 'owner', MYRA);
  });

  it("leaves a person's update, history and restore at same-user reach", async () => {
    const f = fixture(WREN);
    await asPerson(() => handleUpdateMemory({ memoryId: MEMORY, salience: 'high' }, f.composer));
    await asPerson(() => handleGetMemoryHistory({ memoryId: MEMORY }, f.composer));
    await asPerson(() => handleRestoreMemory({ historyId: HISTORY }, f.composer));

    expect(f.repo.updateMemory.mock.calls[0]![3]).toBeUndefined();
    expect(f.repo.getMemoryHistory).toHaveBeenCalledWith(MEMORY, 'owner', undefined);
    expect(f.repo.restoreMemory).toHaveBeenCalledWith(HISTORY, 'owner', undefined);
  });
});

describe('recall, by caller', () => {
  it('reads as the bound token when no slug is passed', async () => {
    const f = fixture(MYRA);
    await asMyra(() => handleRecall({ query: 'fact' }, f.composer));
    expect(f.repo.recallWithScores).toHaveBeenCalledWith(
      'owner',
      'fact',
      expect.objectContaining({ sbSlug: 'myra', sbId: MYRA })
    );
  });

  it('refuses a bound token naming another SB, and reads nothing', async () => {
    const f = fixture(MYRA);
    const result = await asMyra(() => handleRecall({ query: 'fact', sbSlug: 'wren' }, f.composer));
    expect(parsed(result).success).toBe(false);
    expect(f.repo.recallWithScores).not.toHaveBeenCalled();
  });

  it('refuses a call with no identity, rather than reading every SB', async () => {
    // A recall with no slug used to apply no owner filter at all.
    const f = fixture(MYRA);
    const result = await asPerson(() => handleRecall({ query: 'fact' }, f.composer));
    expect(parsed(result).success).toBe(false);
    expect(f.repo.recallWithScores).not.toHaveBeenCalled();
  });

  it("lets a person recall a named SB's memories by its canonical id", async () => {
    const f = fixture(WREN);
    await asPerson(() => handleRecall({ query: 'fact', sbSlug: 'wren' }, f.composer));
    expect(f.repo.recallWithScores).toHaveBeenCalledWith(
      'owner',
      'fact',
      expect.objectContaining({ sbSlug: 'wren', sbId: WREN })
    );
  });
});
