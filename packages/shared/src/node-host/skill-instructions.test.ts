import { SkillInstructionDriftError } from './skill-instructions.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, rm, symlink, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { createSkillInstructionHost, sessionSkillLimits } from './skill-instructions.js';
import {
  discoverSkills,
  loadSkillInstruction,
  type SkillInstruction,
} from '../providers/skill-discovery.js';
import { createSessionSkills } from './session-skills.js';
import { ToolPolicyState } from '../runtime/tool-policy.js';

const hooks = vi.hoisted(() => ({
  home: '',
  afterRealpath: undefined as undefined | ((path: string) => void | Promise<void>),
}));
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => hooks.home,
}));
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return {
    ...actual,
    realpath: async (path: string) => {
      const value = await actual.realpath(path);
      await hooks.afterRealpath?.(path);
      return value;
    },
  };
});

let root: string;
let cwd: string;
let home: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ink-skill-instructions-')));
  cwd = join(root, 'cwd');
  home = join(root, 'home');
  hooks.home = home;
  await mkdir(cwd);
  await mkdir(home);
});
afterEach(async () => {
  hooks.afterRealpath = undefined;
  await rm(root, { recursive: true, force: true });
});
async function put(path: string, content = 'Review this fixture.') {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), content);
  return path;
}

describe('explicit-root asynchronous skill instructions', () => {
  it('matches the CLI root order, nested names, dedupe, trust and truncated text', async () => {
    await put(join(cwd, '.codex', 'skills', 'a'));
    const local = await put(join(home, '.codex', 'skills', 'a'));
    await writeFile(join(local, 'skill-provenance.json'), '{broken');
    await writeFile(
      join(local, 'provenance.json'),
      JSON.stringify({ trusted: true, registry: 'fixture', digest: 'install-v1' })
    );
    await put(join(home, '.gemini', 'skills', 'nested', '.system', 'b'));
    const long = await put(join(cwd, '.ink', 'skills', 'z'), 'a'.repeat(8100));
    const host = createSkillInstructionHost(cwd, home);
    expect(await host.discover()).toEqual(discoverSkills(cwd));
    for (const skill of await host.discover()) {
      const loaded = await host.load(skill);
      const { contentDigest, ...instruction } = loaded;
      expect(instruction).toEqual(loadSkillInstruction(skill));
      expect(contentDigest).toBe(
        createHash('sha256')
          .update(await readFile(join(skill.path, 'SKILL.md')))
          .digest('hex')
      );
    }
    const z = (await host.discover()).find((skill) => skill.path === long)!;
    expect((await host.load(z)).content).toBe(`${'a'.repeat(8000)}\n\n...[truncated]`);
    const sameRoot = createSkillInstructionHost(cwd, cwd);
    hooks.home = cwd;
    expect(await sameRoot.discover()).toEqual(discoverSkills(cwd));
  });

  it('uses only the explicit roots, works concurrently, and accepts absent catalogs', async () => {
    await put(join(cwd, '.ink', 'skills', 'repo'));
    await put(join(home, '.ink', 'skills', 'home'));
    hooks.home = join(root, 'ambient');
    await put(join(hooks.home, '.ink', 'skills', 'forbidden'));
    const hosts = [
      createSkillInstructionHost(cwd, home),
      createSkillInstructionHost(join(root, 'empty'), join(root, 'empty-home')),
    ];
    expect(
      (await Promise.all(hosts.map((host) => host.discover()))).map((skills) =>
        skills.map((s) => s.name)
      )
    ).toEqual([['home', 'repo'], []]);
    expect(() => createSkillInstructionHost('.', home)).toThrow('absolute');
    expect(() => createSkillInstructionHost(cwd, 'relative')).toThrow('absolute');
  });

  it('activates and clears through the real shared policy/control composition without granting tools', async () => {
    await put(join(cwd, '.ink', 'skills', 'review'));
    const state = { sessionId: 'fixture', activeSkills: [] as SkillInstruction[] };
    const policy = new ToolPolicyState('backend');
    policy.denyTool('bash');
    const skills = createSessionSkills({
      state: () => state,
      policy,
      ...createSkillInstructionHost(cwd, home),
    });
    expect((await skills.activate('review')).allowed).toBe(true);
    expect(state.activeSkills[0].contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(policy.canCallInkTool('bash', 'fixture').allowed).toBe(false);
    expect(skills.clear('review')).toBe(1);
    policy.setAllowedSkills(['other']);
    expect((await skills.activate('review')).allowed).toBe(false);
    expect(state.activeSkills).toEqual([]);
  });

  it.each(['path', 'name', 'source', 'trust', 'traversal'] as const)(
    'refuses a substituted %s at load',
    async (change) => {
      await put(join(cwd, '.ink', 'skills', 'review'));
      const host = createSkillInstructionHost(cwd, home);
      const [skill] = await host.discover();
      if (change === 'path') skill.path = join(root, 'outside');
      if (change === 'name') skill.name = 'different';
      if (change === 'source') skill.source = 'home:~/.ink/skills';
      if (change === 'trust') skill.trustLevel = 'untrusted';
      if (change === 'traversal') skill.path += '/../../review';
      await expect(host.load(skill)).rejects.toThrow();
    }
  );

  it('refuses changed provenance and pins a caller-owned selection during async load', async () => {
    const path = await put(join(home, '.ink', 'skills', 'review'));
    const host = createSkillInstructionHost(cwd, home);
    const [skill] = await host.discover();
    await writeFile(join(path, 'provenance.json'), JSON.stringify({ trusted: true }));
    await expect(host.load(skill)).rejects.toBeInstanceOf(SkillInstructionDriftError);
    const [fresh] = await host.discover();
    const loading = host.load(fresh);
    fresh.name = 'mutated';
    fresh.provenance!.trusted = false;
    expect(await loading).toMatchObject({
      name: 'review',
      trustLevel: 'trusted',
      provenance: { trusted: true },
    });
  });

  it('refuses provenance drift during the instruction read and a disappeared file', async () => {
    const path = await put(join(home, '.ink', 'skills', 'review'));
    const host = createSkillInstructionHost(cwd, home);
    const [skill] = await host.discover();
    hooks.afterRealpath = async (file) => {
      if (file.endsWith('SKILL.md'))
        await writeFile(join(path, 'provenance.json'), JSON.stringify({ trusted: true }));
    };
    await expect(host.load(skill)).rejects.toThrow('provenance changed during loading');
    hooks.afterRealpath = undefined;
    const [fresh] = await host.discover();
    await rm(join(path, 'SKILL.md'));
    await expect(host.load(fresh)).rejects.toThrow();
  });

  it('does not interpret malformed metadata trust labels as grants', async () => {
    const path = await put(join(home, '.ink', 'skills', 'review'));
    await writeFile(join(path, 'skill-provenance.json'), 'null');
    await writeFile(
      join(path, 'provenance.json'),
      JSON.stringify({ trusted: 'yes', registry: 42 })
    );
    expect(await createSkillInstructionHost(cwd, home).discover()).toMatchObject([
      { name: 'review', trustLevel: 'local', provenance: {} },
    ]);
  });

  it.each(['catalog', 'dot-dir', 'marker', 'provenance', 'nested'] as const)(
    'omits linked %s without hiding independent catalogs or borrowing trust',
    async (kind) => {
      const path = await put(join(cwd, '.ink', 'skills', 'review'));
      const external = await put(join(root, 'outside'));
      await put(join(external, 'child'));
      await put(join(external, 'skills', 'review'));
      await put(join(cwd, '.gemini', 'skills', 'healthy'));
      if (kind === 'catalog') {
        await rm(join(cwd, '.ink', 'skills'), { recursive: true });
        await symlink(external, join(cwd, '.ink', 'skills'));
      } else if (kind === 'dot-dir') {
        await rm(join(cwd, '.ink'), { recursive: true });
        await symlink(external, join(cwd, '.ink'));
      } else if (kind === 'marker') {
        await rm(join(path, 'SKILL.md'));
        await symlink(join(external, 'SKILL.md'), join(path, 'SKILL.md'));
      } else if (kind === 'provenance') {
        await writeFile(join(external, 'provenance.json'), '{}');
        await symlink(join(external, 'provenance.json'), join(path, 'provenance.json'));
      } else {
        await rm(join(path, 'SKILL.md'));
        await symlink(external, join(path, '.system'));
      }
      expect(
        (await createSkillInstructionHost(cwd, home).discover()).map((skill) => skill.name)
      ).toEqual(['healthy']);
    }
  );

  it('refuses a marker replaced with a directory or link between discovery and load', async () => {
    const path = await put(join(cwd, '.ink', 'skills', 'review'));
    const host = createSkillInstructionHost(cwd, home);
    const [skill] = await host.discover();
    await rm(join(path, 'SKILL.md'));
    await mkdir(join(path, 'SKILL.md'));
    await expect(host.load(skill)).rejects.toThrow('regular file');
    await rm(join(path, 'SKILL.md'), { recursive: true });
    const other = await put(join(root, 'other'));
    await symlink(join(other, 'SKILL.md'), join(path, 'SKILL.md'));
    await expect(host.load(skill)).rejects.toThrow('Linked skill');
  });

  it('fails bounded oversized files explicitly, not as empty successful skills', async () => {
    const path = await put(
      join(cwd, '.ink', 'skills', 'review'),
      'a'.repeat(sessionSkillLimits.instructionBytes)
    );
    const host = createSkillInstructionHost(cwd, home);
    const [skill] = await host.discover();
    expect((await host.load(skill)).content).toHaveLength(8000 + '\n\n...[truncated]'.length);
    await writeFile(join(path, 'SKILL.md'), 'a'.repeat(sessionSkillLimits.instructionBytes + 1));
    await expect(host.load(skill)).rejects.toThrow('byte limit');
    await writeFile(
      join(path, 'provenance.json'),
      ' '.repeat(sessionSkillLimits.provenanceBytes + 1)
    );
    expect(await host.discover()).toEqual([]);
    await expect(host.load(skill)).rejects.toThrow('byte limit');
  });

  it.each(['marker-directory', 'provenance-directory', 'provenance-oversized'] as const)(
    'isolates %s from healthy siblings and other sessions',
    async (kind) => {
      const path = await put(join(home, '.ink', 'skills', 'bad'));
      if (kind === 'marker-directory') {
        await rm(join(path, 'SKILL.md'));
        await mkdir(join(path, 'SKILL.md'));
      } else if (kind === 'provenance-directory') {
        await mkdir(join(path, 'provenance.json'));
      } else {
        await writeFile(
          join(path, 'provenance.json'),
          ' '.repeat(sessionSkillLimits.provenanceBytes + 1)
        );
      }
      await put(join(home, '.ink', 'skills', 'healthy'));
      await put(join(cwd, '.codex', 'skills', 'repo'));
      const [first, second] = await Promise.all([
        createSkillInstructionHost(cwd, home).discover(),
        createSkillInstructionHost(join(root, 'other-session'), home).discover(),
      ]);
      expect(first.map((skill) => skill.name)).toEqual(['healthy', 'repo']);
      expect(second.map((skill) => skill.name)).toEqual(['healthy']);
    }
  );

  it('isolates a non-directory catalog and preserves a filesystem AbortError', async () => {
    await mkdir(join(home, '.ink'));
    await writeFile(join(home, '.ink', 'skills'), 'not a directory');
    await put(join(cwd, '.ink', 'skills', 'healthy'));
    const host = createSkillInstructionHost(cwd, home);
    expect((await host.discover()).map((skill) => skill.name)).toEqual(['healthy']);
    hooks.afterRealpath = () => {
      throw Object.assign(new Error('aborted I/O'), { name: 'AbortError' });
    };
    await expect(host.discover()).rejects.toThrow('aborted I/O');
  });

  it('bounds catalog enumeration including non-directory entries', async () => {
    const dir = join(cwd, '.ink', 'skills');
    await mkdir(dir, { recursive: true });
    for (let start = 0; start <= sessionSkillLimits.entries; start += 64) {
      await Promise.all(
        Array.from({ length: Math.min(64, sessionSkillLimits.entries + 1 - start) }, (_, i) =>
          writeFile(join(dir, `entry-${start + i}`), '')
        )
      );
    }
    await expect(createSkillInstructionHost(cwd, home).discover()).rejects.toThrow('entry limit');
  });

  it('refuses already cancelled and mid-discovery/load cancellation without activation', async () => {
    await put(join(cwd, '.ink', 'skills', 'review'));
    const host = createSkillInstructionHost(cwd, home);
    const [skill] = await host.discover();
    const stop = new AbortController();
    stop.abort(new Error('fixture stop'));
    await expect(host.discover(stop.signal)).rejects.toThrow('fixture stop');
    await expect(host.load(skill, stop.signal)).rejects.toThrow('fixture stop');
    const discovery = new AbortController();
    hooks.afterRealpath = () => discovery.abort(new Error('discover stop'));
    await expect(host.discover(discovery.signal)).rejects.toThrow('discover stop');
    const loading = new AbortController();
    hooks.afterRealpath = (path) => {
      if (path.endsWith('SKILL.md')) loading.abort(new Error('load stop'));
    };
    const state = { sessionId: 'fixture', activeSkills: [] as SkillInstruction[] };
    const controls = createSessionSkills({
      state: () => state,
      policy: new ToolPolicyState('backend'),
      discover: () => [skill],
      load: host.load,
    });
    await expect(controls.activate('review', loading.signal)).rejects.toThrow('load stop');
    expect(state.activeSkills).toEqual([]);
  });
});
