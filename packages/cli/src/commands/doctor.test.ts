import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { analyzeCliLink, applyCliLinkFix, buildFixArgs } from './doctor.js';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: vi.fn((_binary, _args, callback) => callback(null, '', '')),
}));

describe('doctor repair execution', () => {
  it.each([
    '../demo',
    '/tmp/demo',
    'ink demo',
    'ink;echo',
    'ink$(echo marker)',
    '--demo',
    'ink\n',
    'ink\r',
    '',
  ])('rejects unsafe aliases before execution: %s', (name) =>
    expect(() => buildFixArgs(name)).toThrow('CLI alias')
  );

  it('keeps the alias as a validated argument, not shell text', async () => {
    expect(buildFixArgs('ink')).toEqual(['studio', 'cli']);
    expect(buildFixArgs('ink-demo')).toEqual(['studio', 'cli', '--name', 'ink-demo']);
    await applyCliLinkFix('ink-demo');
    expect(execFile).toHaveBeenCalledWith(
      'ink',
      ['studio', 'cli', '--name', 'ink-demo'],
      expect.any(Function)
    );
  });
});

function makeFs(overrides?: {
  files?: Record<string, string>;
  symlinks?: Record<string, string>;
  modes?: Record<string, number>;
}) {
  const files = overrides?.files || {};
  const symlinks = overrides?.symlinks || {};
  const modes = overrides?.modes || {};

  return {
    existsSync(path: string) {
      return path in files || path in symlinks;
    },
    lstatSync(path: string) {
      return {
        isSymbolicLink() {
          return path in symlinks;
        },
      };
    },
    readlinkSync(path: string) {
      return symlinks[path] || '';
    },
    realpathSync(path: string) {
      return path;
    },
    statSync(path: string) {
      return { mode: modes[path] ?? 0o755 };
    },
    readFileSync(path: string) {
      if (path in files) return files[path]!;
      throw new Error(`missing file ${path}`);
    },
  };
}

describe('analyzeCliLink', () => {
  it('defaults to ink binary name when no identity hint is available', () => {
    const originalSlug = process.env.AGENT_ID;
    delete process.env.AGENT_ID;
    try {
      const fsOps = makeFs();
      const result = analyzeCliLink({ binDir: '/bin' }, fsOps as never);
      expect(result.binaryName.startsWith('ink')).toBe(true);
      const linkedBinaryCheck = result.checks.find((check) => check.name === 'Linked binary');
      expect(linkedBinaryCheck?.detail).toContain('run: ink studio cli');
    } finally {
      if (originalSlug === undefined) delete process.env.AGENT_ID;
      else process.env.AGENT_ID = originalSlug;
    }
  });

  it('uses AGENT_ID as fallback binary hint when present', () => {
    const originalSlug = process.env.AGENT_ID;
    process.env.AGENT_ID = 'lumen';
    try {
      const fsOps = makeFs();
      const result = analyzeCliLink({ binDir: '/bin' }, fsOps as never);
      expect(result.binaryName.startsWith('ink')).toBe(true);
      const linkedBinaryCheck = result.checks.find((check) => check.name === 'Linked binary');
      if (result.binaryName === 'ink-lumen') {
        expect(linkedBinaryCheck?.detail).toContain('run: ink studio cli --name ink-lumen');
      } else {
        expect(linkedBinaryCheck?.detail).toContain('run: ink studio cli');
      }
    } finally {
      if (originalSlug === undefined) delete process.env.AGENT_ID;
      else process.env.AGENT_ID = originalSlug;
    }
  });

  it('reports failure when linked binary is missing', () => {
    const fsOps = makeFs();
    const result = analyzeCliLink({ name: 'ink-lumen', binDir: '/bin' }, fsOps as never);
    expect(result.checks.some((check) => check.status === 'fail')).toBe(true);
    expect(result.checks.some((check) => check.name === 'Linked binary')).toBe(true);
  });

  it('reports healthy symlink and target checks', () => {
    const cwd = process.cwd();
    const cliRoot = `${cwd}/packages/cli`;
    const cliTarget = `${cliRoot}/dist/cli.js`;
    const fsOps = makeFs({
      files: {
        [`${cliRoot}/package.json`]: JSON.stringify({ name: '@inklabs/cli' }),
        [cliTarget]: '#!/usr/bin/env node',
      },
      symlinks: {
        '/bin/ink-lumen': cliTarget,
      },
      modes: {
        [cliTarget]: 0o755,
      },
    });
    const result = analyzeCliLink({ name: 'ink-lumen', binDir: '/bin' }, fsOps as never);
    const failing = result.checks.filter((check) => check.status === 'fail');
    expect(failing).toHaveLength(0);
    expect(result.checks.some((check) => check.name === 'Symlink')).toBe(true);
    expect(result.checks.some((check) => check.name === 'Studio target match')).toBe(true);
  });
});

describe('studio checklist as doctor checks (task c3b34be8)', () => {
  const audit = (overrides: Partial<{ ok: boolean; required: boolean }>[]) => ({
    worktreePath: '/w',
    linked: true,
    checks: overrides.map((o, i) => ({
      id: 'mcp-json' as const,
      label: `item ${i}`,
      ok: o.ok ?? true,
      required: o.required ?? true,
      detail: o.ok === false ? 'missing' : 'present',
      repair: 'ink init',
    })),
    missing: [],
    complete: overrides.every((o) => o.ok !== false || o.required === false),
  });

  it('a required missing item fails, a reported-only one warns, and each names the repair', async () => {
    const { studioChecksFrom } = await import('./doctor.js');
    const checks = studioChecksFrom(
      audit([{ ok: true }, { ok: false }, { ok: false, required: false }]),
      'not-applicable'
    );
    expect(checks.map((c) => c.status)).toEqual(['ok', 'fail', 'warn']);
    expect(checks[1].detail).toContain('ink init');
    expect(checks[2].detail).toContain('ink init');
    expect(checks.every((c) => c.name.startsWith('Studio: '))).toBe(true);
  });

  it('registration is a check of its own for a linked worktree and absent for the main one', async () => {
    const { studioChecksFrom } = await import('./doctor.js');
    const base = audit([{ ok: true }]);
    expect(studioChecksFrom(base, 'not-applicable').map((c) => c.name)).toEqual(['Studio: item 0']);
    expect(studioChecksFrom(base, 'registered').at(-1)?.status).toBe('ok');
    expect(studioChecksFrom(base, 'unregistered').at(-1)?.status).toBe('fail');
    expect(studioChecksFrom(base, 'unreachable').at(-1)?.status).toBe('warn');
  });
});

describe('doctor: the registration probe (task 2841c7a9)', () => {
  const row = { success: true, studio: { id: '191b7705-85bd-4c76-b622-43f655bf7fd6' } };

  it('an id from identity.json is checked as that id', async () => {
    const { probeRegistration } = await import('./doctor.js');
    const call = vi.fn(async () => row);
    expect(
      await probeRegistration('191b7705-85bd-4c76-b622-43f655bf7fd6', '/repo--alpha', call)
    ).toBe('registered');
    expect(call).toHaveBeenCalledWith(
      'get_studio',
      { studioId: '191b7705-85bd-4c76-b622-43f655bf7fd6' },
      { idempotent: true }
    );
  });

  it('without an id, a row the server has for this path is "unrecorded", not "no studio row"', async () => {
    // Lumen's Inktrade studio on 2026-09-29: created by the server, never
    // given an identity file. `ink doctor` said the server had no row for it
    // while `get_studio` by path returned one.
    const { probeRegistration } = await import('./doctor.js');
    const call = vi.fn(async () => row);
    expect(await probeRegistration(undefined, '/repo--alpha', call)).toBe('unrecorded');
    expect(call).toHaveBeenCalledWith('get_studio', { path: '/repo--alpha' }, { idempotent: true });
  });

  it('without an id and without a row it is unregistered; a server failure is unreachable', async () => {
    const { probeRegistration } = await import('./doctor.js');
    const notFound = vi.fn(async () => {
      throw new Error('Inkwell tool error: Studio not found');
    });
    expect(await probeRegistration(undefined, '/repo--alpha', notFound)).toBe('unregistered');
    const down = vi.fn(async () => {
      throw new Error('Inkwell fetch failed for http://localhost:3001/mcp: fetch failed');
    });
    expect(await probeRegistration(undefined, '/repo--alpha', down)).toBe('unreachable');
  });

  it('"unrecorded" fails the check and names identity.json and the repair', async () => {
    const { studioChecksFrom } = await import('./doctor.js');
    const check = studioChecksFrom(
      {
        worktreePath: '/repo--alpha',
        linked: true,
        checks: [],
        missing: [],
        complete: true,
      },
      'unrecorded'
    ).at(-1);
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('identity.json');
    expect(check?.detail).toContain('ink init');
  });
});
