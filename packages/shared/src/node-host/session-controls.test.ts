import { describe, it, expect, vi } from 'vitest';
import { SkillInstructionDriftError } from './skill-instructions.js';
import { createSessionControls } from './session-controls.js';
import {
  SessionLog,
  ToolPolicyState,
  createProviderRecovery,
  type SessionControlReceipt,
  type SessionControlRecord,
} from '../runtime/index.js';
import type { SkillInstruction, DiscoveredSkill } from '../providers/skill-discovery.js';

const skill: SkillInstruction = {
  name: 'review',
  path: '/fixture/review',
  source: 'repo:.ink',
  trustLevel: 'local',
  contentDigest: 'a'.repeat(64),
  content: 'CHECK THE FIXTURE',
  provenance: { registry: 'fixture' },
};
function fixture(withSkills = true) {
  const events: Record<string, unknown>[] = [];
  let write = async (line: string) => {
    events.push(JSON.parse(line));
  };
  const log = new SessionLog({
    path: '/fixture/session.jsonl',
    sink: { write: (line) => write(line) },
  });
  const runtime = {
    sessionId: 'one',
    backend: 'claude',
    model: 'before' as string | undefined,
    detectedModel: undefined as string | undefined,
    backendTokenWindow: 200_000,
    maxContextTokens: 100_000,
    activeSkills: [] as SkillInstruction[],
  };
  const policy = new ToolPolicyState('backend');
  const skills = {
    discover: vi.fn(async () => [skill]),
    load: vi.fn(async (_candidate: DiscoveredSkill, _signal?: AbortSignal) => ({ ...skill })),
  };
  const invalidateProvider = vi.fn();
  let admitted = true;
  const receipts: SessionControlReceipt[] = [];
  const notice = vi.fn();
  const control = createSessionControls({
    runtime,
    log,
    policy,
    skills: withSkills ? skills : undefined,
    notice,
    contextBudgetAuto: true,
    assertCurrent: () => {
      if (!admitted) throw new Error('old owner');
    },
    invalidateProvider,
    mintId: () => 'replay-removal',
    receipt: (value) => receipts.push(value),
  });
  return {
    control,
    runtime,
    events,
    log,
    skills,
    policy,
    invalidateProvider,
    receipts,
    notice,
    setWrite: (fn: typeof write) => {
      write = fn;
    },
    retire: () => {
      admitted = false;
    },
  };
}
const record = (selection: SessionControlRecord['selection']): SessionControlRecord => ({
  type: 'session_control',
  version: 1,
  controlId: 'earlier',
  backend: 'claude',
  selection,
});
const ref = (({ content, ...rest }) => rest)(
  skill
) as SessionControlRecord['selection']['skills'][number];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('sole-composer durable controls', () => {
  it('queues without effect; commits before applying, including no-op invalidation', async () => {
    const h = fixture();
    const gate = deferred();
    const writing = deferred();
    h.setWrite(async (line) => {
      writing.resolve();
      await gate.promise;
      h.events.push(JSON.parse(line));
    });
    const request = { controlId: 'first', action: 'model' as const, model: 'after' };
    expect(h.control.enqueue(request).status).toBe('pending');
    const run = h.control.drain();
    await writing.promise;
    expect(h.runtime.model).toBe('before');
    expect(h.invalidateProvider).not.toHaveBeenCalled();
    expect(h.receipts).toEqual([]);
    gate.resolve();
    await run;
    expect(h.runtime.model).toBe('after');
    expect(h.receipts[0]).toMatchObject({ status: 'applied', eid: 1 });
    expect(h.control.enqueue(request)).toEqual(h.receipts[0]);
    h.control.enqueue({ ...request, controlId: 'again' });
    await h.control.drain();
    expect(h.invalidateProvider).toHaveBeenCalledTimes(2);
  });
  it('does not persist instructions or grant tools, and clears skills durably', async () => {
    const h = fixture();
    const policy = h.policy.snapshot();
    h.control.enqueue({ controlId: 'use', action: 'skill_use', name: 'review' });
    await h.control.drain();
    expect(h.runtime.activeSkills[0]?.content).toBe(skill.content);
    expect(JSON.stringify(h.events)).not.toContain(skill.content);
    expect(h.events[0]).toMatchObject({ selection: { skills: [ref] } });
    expect(h.policy.snapshot()).toEqual(policy);
    h.control.enqueue({ controlId: 'clear', action: 'skill_clear' });
    await h.control.drain();
    expect(h.runtime.activeSkills).toEqual([]);
    expect(h.events[1]).toMatchObject({ selection: { skills: [] } });
  });
  it('replays full-log state independently of compaction and honors explicit model reset', async () => {
    const h = fixture();
    h.control.replay(record({ model: null, skills: [ref] }));
    h.control.replay({ type: 'compaction' });
    await h.control.restore();
    expect(h.runtime.model).toBeUndefined();
    expect(h.runtime.activeSkills).toHaveLength(1);
    expect(h.events).toEqual([]);
  });
  it.each(['content', 'provenance', 'identity', 'policy', 'missing'])(
    'durably removes a replayed skill on %s drift and never resurrects it',
    async (kind) => {
      const h = fixture();
      if (kind === 'content')
        h.skills.load.mockResolvedValue({ ...skill, contentDigest: 'b'.repeat(64) });
      if (kind === 'provenance')
        h.skills.load.mockResolvedValue({ ...skill, provenance: { registry: 'changed' } });
      if (kind === 'identity') h.skills.load.mockResolvedValue({ ...skill, path: '/other' });
      if (kind === 'policy') vi.spyOn(h.policy, 'isSkillAllowed').mockReturnValue(false);
      if (kind === 'missing')
        h.skills.load.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
      h.control.replay(record({ skills: [ref] }));
      await h.control.restore();
      expect(h.runtime.activeSkills).toEqual([]);
      expect(h.events[0]).toMatchObject({
        type: 'session_control',
        reason: 'replay_skill_removed',
        selection: { skills: [] },
      });
      const next = fixture();
      next.control.replay(h.events[0]);
      await next.control.restore();
      expect(next.skills.load).not.toHaveBeenCalled();
      expect(next.runtime.activeSkills).toEqual([]);
    }
  );
  it('skips malformed and future records, retains last valid state and reports only static diagnostics', async () => {
    const h = fixture();
    h.control.replay(record({ model: 'valid', skills: [ref] }));
    for (const bad of [
      { ...record({ skills: [] }), version: 2 },
      { type: 'session_control', selection: 'SECRET RECORD BYTES' },
    ])
      expect(() => h.control.replay(bad)).not.toThrow();
    await h.control.restore();
    expect(h.runtime.model).toBe('valid');
    expect(h.runtime.activeSkills).toHaveLength(1);
    expect(h.events).toEqual([]);
    expect(h.notice).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.notice.mock.calls)).not.toContain('SECRET');
    expect(h.invalidateProvider).toHaveBeenCalledOnce();
    const empty = fixture();
    empty.control.replay({ type: 'session_control', version: 2 });
    await expect(empty.control.restore()).resolves.toBeUndefined();
    expect(empty.invalidateProvider).toHaveBeenCalledOnce();
  });
  it('commits a backend reset before effect, re-gates skills, and does not keep the old model', async () => {
    const h = fixture();
    h.control.replay({ ...record({ model: 'old-provider', skills: [ref] }), backend: 'codex' });
    const gate = deferred(),
      writing = deferred();
    h.setWrite(async (line) => {
      writing.resolve();
      await gate.promise;
      h.events.push(JSON.parse(line));
    });
    const run = h.control.restore();
    await writing.promise;
    expect(h.runtime.activeSkills).toEqual([]);
    expect(h.invalidateProvider).not.toHaveBeenCalled();
    gate.resolve();
    await run;
    expect(h.runtime.model).toBe('before'); // new host's configured model wins
    expect(h.runtime.activeSkills).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      backend: 'claude',
      reason: 'replay_backend_changed',
      selection: { skills: [ref] },
    });
    expect(h.events[0].selection).not.toHaveProperty('model');
    const next = fixture();
    next.control.replay(h.events[0]);
    await next.control.restore();
    expect(next.events).toEqual([]); // migration happens once, not on every run
  });
  it.each(['EMFILE', 'EACCES', 'EIO', 'unclassified', 'missing_port'])(
    'retains a %s selection through a later model control and retries it next run',
    async (code) => {
      const h = fixture(code !== 'missing_port');
      h.skills.load.mockRejectedValue(Object.assign(new Error('private path'), { code }));
      h.control.replay(record({ skills: [ref] }));
      await h.control.restore();
      expect(h.events).toEqual([]);
      expect(h.runtime.activeSkills).toEqual([]);
      expect(h.runtime).toHaveProperty('providerRecoveryDisabled', true);
      expect(h.invalidateProvider).toHaveBeenCalledOnce();
      h.control.enqueue({ controlId: 'model', action: 'model', model: 'changed' });
      await h.control.drain();
      expect(h.events[0]).toMatchObject({ selection: { model: 'changed', skills: [ref] } });
      const next = fixture();
      next.control.replay(h.events[0]);
      await next.control.restore();
      expect(next.runtime.activeSkills).toHaveLength(1);
      expect(next.events).toEqual([]);
      // A user can still deliberately clear an unavailable selection.
      h.control.enqueue({ controlId: 'clear', action: 'skill_clear', name: 'review' });
      await h.control.drain();
      expect(h.events[1]).toMatchObject({ selection: { skills: [] } });
    }
  );
  it('persists only positive removals when drift and transient errors coexist', async () => {
    const h = fixture();
    const absent = { ...ref, name: 'absent', path: '/fixture/absent' };
    h.skills.load.mockImplementation(async (s) => {
      if (s.name === 'absent') throw new SkillInstructionDriftError('provenance changed');
      throw Object.assign(new Error('busy'), { code: 'EMFILE' });
    });
    h.control.replay({ ...record({ skills: [ref, absent] }), backend: 'codex' });
    await h.control.restore();
    expect(h.events[0]).toMatchObject({
      reason: 'replay_backend_changed',
      selection: { skills: [ref] },
    });
    expect(h.runtime.activeSkills).toEqual([]);
  });
  it('retains a late cancellation as unknown, blocks launches/drains, and does not apply', async () => {
    const h = fixture();
    const gate = deferred();
    const writing = deferred();
    const stop = new AbortController();
    h.setWrite(async (line) => {
      writing.resolve();
      await gate.promise;
      h.events.push(JSON.parse(line));
    });
    h.control.enqueue({ controlId: 'cancel', action: 'model', model: 'late' });
    const run = h.control.drain(stop.signal);
    await writing.promise;
    stop.abort();
    gate.resolve();
    await expect(run).rejects.toThrow();
    expect(h.runtime.model).toBe('before');
    expect(h.receipts[0].status).toBe('unknown');
    await expect(h.control.drain()).rejects.toThrow(/uncertain/);
    expect(h.events).toHaveLength(1); // the receipt must not lie about absence
  });
  it('fails closed on a write rejection', async () => {
    const h = fixture();
    h.setWrite(async () => {
      throw new Error('disk');
    });
    h.control.enqueue({ controlId: 'disk', action: 'model', model: 'late' });
    await expect(h.control.drain()).rejects.toThrow(/uncertain/);
    expect(h.receipts[0].status).toBe('unknown');
    expect(h.runtime.model).toBe('before');
  });
  it('checks policy again after loading and during persistence', async () => {
    const h = fixture();
    h.skills.load.mockImplementation(async () => {
      vi.spyOn(h.policy, 'isSkillAllowed').mockReturnValue(false);
      return skill;
    });
    h.control.enqueue({ controlId: 'load', action: 'skill_use', name: 'review' });
    await h.control.drain();
    expect(h.events).toEqual([]);
    expect(h.receipts[0].status).toBe('refused');
    const other = fixture();
    other.setWrite(async (line) => {
      other.events.push(JSON.parse(line));
      vi.spyOn(other.policy, 'isSkillAllowed').mockReturnValue(false);
    });
    other.control.enqueue({ controlId: 'write', action: 'skill_use', name: 'review' });
    await expect(other.control.drain()).rejects.toThrow(/uncertain/);
    expect(other.receipts[0].status).toBe('unknown');
  });
  it('fences application after a load, and keeps sessions independent', async () => {
    const a = fixture(),
      b = fixture();
    a.skills.load.mockImplementation(async () => {
      a.retire();
      return skill;
    });
    a.control.enqueue({ controlId: 'same', action: 'skill_use', name: 'review' });
    b.control.enqueue({ controlId: 'same', action: 'model', model: 'other' });
    await expect(a.control.drain()).rejects.toThrow(/owner/);
    await b.control.drain();
    expect(a.events).toEqual([]);
    expect(a.receipts[0].status).toBe('refused');
    expect(b.runtime.model).toBe('other');
  });
  it('closes enqueue before a final drain and rejects id substitution', async () => {
    const h = fixture();
    const request = { controlId: 'one', action: 'model' as const, model: null };
    h.control.enqueue(request);
    expect(h.control.enqueue({ ...request, model: 'different' }).reason).toBe(
      'control_id_conflict'
    );
    h.control.close();
    expect(h.control.enqueue({ ...request, controlId: 'late' }).status).toBe('refused');
    await h.control.drain();
    expect(h.receipts[0].status).toBe('applied');
  });
  it('bounds pending requests plus receipt evidence without evicting dedupe', () => {
    const h = fixture();
    for (let i = 0; i < 128; i++)
      expect(h.control.enqueue({ controlId: String(i), action: 'skill_clear' }).status).toBe(
        'pending'
      );
    expect(h.control.enqueue({ controlId: '129', action: 'skill_clear' }).reason).toBe(
      'control_capacity'
    );
    h.control.refusePending('stopped');
    expect(h.receipts).toHaveLength(128);
  });
  it('a control invalidates native recovery only until a new baseline is written', () => {
    const recovery = createProviderRecovery('claude');
    recovery.push({ type: 'backend_session', id: 'stale', routing: 'local' });
    recovery.push(record({ model: 'new', skills: [] }));
    expect(recovery.session).toBeUndefined();
    recovery.push({ type: 'backend_session', id: 'new', routing: 'local' });
    recovery.push({ type: 'assistant', content: 'reply' });
    expect(recovery.session?.id).toBe('new');
  });
});

it('skill-only controls retain a reported model window; an explicit model reset clears it', () => {
  const recovery = createProviderRecovery('claude');
  recovery.push({ type: 'model_detected', backend: 'claude', model: 'reported-large-window' });
  recovery.push(record({ skills: [] }));
  expect(recovery.model).toBe('reported-large-window');
  recovery.push(record({ model: null, skills: [] }));
  expect(recovery.model).toBeUndefined();
});

it('refuses a skill without a durable hash before writing, without poisoning the owner', async () => {
  const h = fixture();
  h.skills.load.mockResolvedValue({ ...skill, contentDigest: undefined });
  h.control.enqueue({ controlId: 'bad-hash', action: 'skill_use', name: 'review' });
  await h.control.drain();
  expect(h.receipts[0].status).toBe('refused');
  expect(h.events).toEqual([]);
  h.control.enqueue({ controlId: 'valid', action: 'model', model: 'next' });
  await h.control.drain();
  expect(h.runtime.model).toBe('next');
});

it.each(['abort', 'retire'])(
  'classifies %s during a drain as stopped for every uncommitted request',
  async (mode) => {
    const h = fixture();
    const stop = new AbortController();
    h.skills.load.mockImplementation(async () => {
      if (mode === 'abort') stop.abort();
      else h.retire();
      return skill;
    });
    h.control.enqueue({ controlId: 'loading', action: 'skill_use', name: 'review' });
    h.control.enqueue({ controlId: 'later', action: 'model', model: 'later' });
    await expect(h.control.drain(stop.signal)).rejects.toThrow();
    expect(h.events).toEqual([]);
    expect(h.receipts).toEqual([
      { controlId: 'loading', status: 'refused', reason: 'owner_stopped' },
      { controlId: 'later', status: 'refused', reason: 'owner_stopped' },
    ]);
  }
);
it('does not recover a seed with temporarily missing instructions or an old provider model window', () => {
  const recovery = createProviderRecovery('claude');
  recovery.push({ type: 'backend_session', id: 'usable' });
  recovery.push({ type: 'backend_session', id: 'incomplete', recoverable: false });
  expect(recovery.session).toBeUndefined();
  recovery.push({ type: 'model_detected', backend: 'claude', model: 'old-window' });
  recovery.push({ ...record({ skills: [] }), backend: 'codex' });
  expect(recovery.model).toBeUndefined();
});

it.each([undefined, 'different', 'earlier'])(
  'matches the native seed selection marker %s before recovery',
  async (controlId) => {
    const h = fixture();
    h.control.replay(record({ model: 'selected', skills: [] }));
    await h.control.restore(undefined, controlId);
    expect(h.invalidateProvider).toHaveBeenCalledTimes(controlId === 'earlier' ? 0 : 1);
    expect(h.runtime).toHaveProperty('appliedControlId', 'earlier');
  }
);
