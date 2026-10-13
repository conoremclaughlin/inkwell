import { describe, expect, it, vi } from 'vitest';
import { createSessionSkills } from './session-skills.js';
import { ToolPolicyState } from '../runtime/tool-policy.js';
import type { DiscoveredSkill, SkillInstruction } from '../providers/skill-discovery.js';

const candidate: DiscoveredSkill = {
  name: 'review',
  path: '/fixture/review',
  source: 'repo:.ink/skills',
  trustLevel: 'trusted',
};
const instruction: SkillInstruction = { ...candidate, content: 'Inspect the fixture carefully.' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(sessionId = 'one') {
  let state = { sessionId, activeSkills: [] as SkillInstruction[] };
  const policy = new ToolPolicyState('backend');
  const discover = vi.fn(() => Promise.resolve([candidate]));
  const load = vi.fn((_skill: DiscoveredSkill, _signal?: AbortSignal) =>
    Promise.resolve(instruction)
  );
  const skills = createSessionSkills({ state: () => state, policy, discover, load });
  return {
    state: () => state,
    replace: () => {
      state = { ...state };
    },
    policy,
    discover,
    load,
    skills,
  };
}

describe('instance-owned manual skill controls', () => {
  it('uses the first discovered name, replaces by path and clears by name or all', async () => {
    const h = fixture();
    h.discover.mockResolvedValue([candidate, { ...candidate, path: '/other/review' }]);
    expect(await h.skills.activate('missing')).toEqual({
      allowed: false,
      reason: 'Skill not found: missing',
    });
    expect(h.load).not.toHaveBeenCalled();
    expect(await h.skills.activate('review')).toMatchObject({ allowed: true, skill: instruction });
    expect(h.load.mock.calls[0][0].path).toBe(candidate.path);
    h.load.mockResolvedValue({ ...instruction, content: 'Updated.' });
    await h.skills.activate('review');
    expect(h.state().activeSkills).toEqual([{ ...instruction, content: 'Updated.' }]);
    expect(h.skills.clear('missing')).toBe(0);
    expect(h.skills.clear('review')).toBe(1);
    await h.skills.activate('review');
    expect(h.skills.clear()).toBe(1);
    expect(h.state().activeSkills).toEqual([]);
  });

  it.each(['skill', 'path', 'trust'] as const)(
    'checks the %s policy before loading',
    async (gate) => {
      const h = fixture();
      if (gate === 'skill') h.policy.setAllowedSkills(['different']);
      if (gate === 'path') h.policy.addReadPathAllow('/other/**');
      if (gate === 'trust') {
        h.discover.mockResolvedValue([{ ...candidate, trustLevel: 'untrusted' }]);
        h.policy.setSkillTrustMode('trusted-only');
      }
      expect(await h.skills.activate('review')).toMatchObject({ allowed: false });
      expect(h.load).not.toHaveBeenCalled();
      expect(h.state().activeSkills).toEqual([]);
    }
  );

  it('rechecks policy after async loading and never grants tool authority', async () => {
    const h = fixture();
    const waiting = deferred<SkillInstruction>();
    h.load.mockReturnValue(waiting.promise);
    const active = h.skills.activate('review');
    await vi.waitFor(() => expect(h.load).toHaveBeenCalledOnce());
    h.policy.setAllowedSkills(['different']);
    waiting.resolve(instruction);
    expect(await active).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('allowlist'),
    });
    expect(h.state().activeSkills).toEqual([]);
    h.policy.setAllowedSkills(['review']);
    h.policy.denyTool('bash');
    expect((await h.skills.activate('review')).allowed).toBe(true);
    expect(h.policy.canCallInkTool('bash', 'one').allowed).toBe(false);
  });

  it.each(['clear', 'clear-name', 'session', 'replace', 'abort'] as const)(
    'does not resurrect a pending load after %s',
    async (action) => {
      const h = fixture();
      const stop = new AbortController();
      const waiting = deferred<SkillInstruction>();
      h.load.mockReturnValue(waiting.promise);
      const active = h.skills.activate('review', stop.signal);
      // Handle an aborted rejection immediately, while still asserting it below.
      void active.catch(() => {});
      await vi.waitFor(() => expect(h.load).toHaveBeenCalledOnce());
      if (action === 'clear') h.skills.clear();
      if (action === 'clear-name') h.skills.clear('review');
      if (action === 'session') h.state().sessionId = 'two';
      if (action === 'replace') h.replace();
      if (action === 'abort') stop.abort();
      waiting.resolve(instruction);
      if (action === 'abort') await expect(active).rejects.toThrow();
      else expect(await active).toMatchObject({ allowed: false });
      expect(h.state().activeSkills).toEqual([]);
    }
  );

  it('fences a session switch while discovery is pending, before loading any content', async () => {
    const h = fixture();
    const waiting = deferred<DiscoveredSkill[]>();
    h.discover.mockReturnValue(waiting.promise);
    const active = h.skills.activate('review');
    h.state().sessionId = 'two';
    waiting.resolve([candidate]);
    expect(await active).toMatchObject({ allowed: false });
    expect(h.load).not.toHaveBeenCalled();
  });

  it('refuses reentrant activation without blocking a different session or later requests', async () => {
    const a = fixture('one'),
      b = fixture('two');
    const waiting = deferred<SkillInstruction>();
    a.load.mockReturnValue(waiting.promise);
    const first = a.skills.activate('review');
    expect(await a.skills.activate('review')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('already loading'),
    });
    expect((await b.skills.activate('review')).allowed).toBe(true);
    expect(a.state().activeSkills).toEqual([]);
    a.skills.clear('unrelated'); // clearing another skill must not cancel review
    waiting.resolve(instruction);
    expect((await first).allowed).toBe(true);
    a.skills.clear();
    expect(b.state().activeSkills).toEqual([instruction]);
    a.load.mockRejectedValueOnce(new Error('synthetic read failure'));
    await expect(a.skills.activate('review')).rejects.toThrow('synthetic read failure');
    expect((await a.skills.activate('review')).allowed).toBe(true);
  });

  it.each(['name', 'path', 'source', 'trustLevel'] as const)(
    'rejects a loader substituting %s',
    async (key) => {
      const h = fixture();
      h.load.mockImplementation(async (skill) => {
        const replacement = {
          ...instruction,
          [key]: key === 'trustLevel' ? 'untrusted' : 'other',
        } as SkillInstruction;
        Object.assign(skill, replacement); // mutating the argument must not change the snapshot
        return replacement;
      });
      expect(await h.skills.activate('review')).toMatchObject({
        allowed: false,
        reason: expect.stringContaining('does not match'),
      });
      expect(h.state().activeSkills).toEqual([]);
    }
  );
});
