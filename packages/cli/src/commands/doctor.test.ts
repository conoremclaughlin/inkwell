import { describe, expect, it } from 'vitest';
import { analyzeCliLink } from './doctor.js';

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
  it('defaults to sb binary name when no identity hint is available', () => {
    const originalAgentId = process.env.AGENT_ID;
    delete process.env.AGENT_ID;
    try {
      const fsOps = makeFs();
      const result = analyzeCliLink({ binDir: '/bin' }, fsOps as never);
      expect(result.binaryName.startsWith('sb')).toBe(true);
      const linkedBinaryCheck = result.checks.find((check) => check.name === 'Linked binary');
      expect(linkedBinaryCheck?.detail).toContain('run: sb studio cli');
    } finally {
      if (originalAgentId === undefined) delete process.env.AGENT_ID;
      else process.env.AGENT_ID = originalAgentId;
    }
  });

  it('uses AGENT_ID as fallback binary hint when present', () => {
    const originalAgentId = process.env.AGENT_ID;
    process.env.AGENT_ID = 'lumen';
    try {
      const fsOps = makeFs();
      const result = analyzeCliLink({ binDir: '/bin' }, fsOps as never);
      expect(result.binaryName.startsWith('sb')).toBe(true);
      const linkedBinaryCheck = result.checks.find((check) => check.name === 'Linked binary');
      if (result.binaryName === 'sb-lumen') {
        expect(linkedBinaryCheck?.detail).toContain('run: sb studio cli --name sb-lumen');
      } else {
        expect(linkedBinaryCheck?.detail).toContain('run: sb studio cli');
      }
    } finally {
      if (originalAgentId === undefined) delete process.env.AGENT_ID;
      else process.env.AGENT_ID = originalAgentId;
    }
  });

  it('reports failure when linked binary is missing', () => {
    const fsOps = makeFs();
    const result = analyzeCliLink({ name: 'sb-lumen', binDir: '/bin' }, fsOps as never);
    expect(result.checks.some((check) => check.status === 'fail')).toBe(true);
    expect(result.checks.some((check) => check.name === 'Linked binary')).toBe(true);
  });

  it('reports healthy symlink and target checks', () => {
    const cwd = process.cwd();
    const cliRoot = `${cwd}/packages/cli`;
    const cliTarget = `${cliRoot}/dist/cli.js`;
    const fsOps = makeFs({
      files: {
        [`${cliRoot}/package.json`]: JSON.stringify({ name: '@personal-context/cli' }),
        [cliTarget]: '#!/usr/bin/env node',
      },
      symlinks: {
        '/bin/sb-lumen': cliTarget,
      },
      modes: {
        [cliTarget]: 0o755,
      },
    });
    const result = analyzeCliLink({ name: 'sb-lumen', binDir: '/bin' }, fsOps as never);
    const failing = result.checks.filter((check) => check.status === 'fail');
    expect(failing).toHaveLength(0);
    expect(result.checks.some((check) => check.name === 'Symlink')).toBe(true);
    expect(result.checks.some((check) => check.name === 'Studio target match')).toBe(true);
  });
});
