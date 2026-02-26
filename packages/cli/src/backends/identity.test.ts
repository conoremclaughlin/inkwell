import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveAgentId } from './identity.js';

describe('resolveAgentId', () => {
  let originalHome: string | undefined;
  let originalAgentEnv: string | undefined;
  let originalBackendEnv: string | undefined;
  let originalCwd: string;
  let rootDir: string;
  let workDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalAgentEnv = process.env.AGENT_ID;
    originalBackendEnv = process.env.SB_BACKEND;
    originalCwd = process.cwd();

    rootDir = mkdtempSync(join(tmpdir(), 'pcp-identity-'));
    workDir = join(rootDir, 'work');
    mkdirSync(workDir, { recursive: true });
    process.chdir(workDir);

    process.env.HOME = rootDir;
    delete process.env.AGENT_ID;
    delete process.env.SB_BACKEND;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentEnv === undefined) delete process.env.AGENT_ID;
    else process.env.AGENT_ID = originalAgentEnv;
    if (originalBackendEnv === undefined) delete process.env.SB_BACKEND;
    else process.env.SB_BACKEND = originalBackendEnv;
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('prefers explicit CLI agent over env/config', () => {
    process.env.AGENT_ID = 'env-agent';
    expect(resolveAgentId('cli-agent', 'codex')).toBe('cli-agent');
  });

  it('uses AGENT_ID env when present', () => {
    process.env.AGENT_ID = 'lumen';
    expect(resolveAgentId(undefined, 'claude')).toBe('lumen');
  });

  it('uses local .pcp/identity.json when env is not set', () => {
    mkdirSync(join(workDir, '.pcp'), { recursive: true });
    writeFileSync(join(workDir, '.pcp', 'identity.json'), JSON.stringify({ agentId: 'aster' }));
    expect(resolveAgentId(undefined, 'gemini')).toBe('aster');
  });

  it('uses backend-specific agentMapping fallback', () => {
    mkdirSync(join(rootDir, '.pcp'), { recursive: true });
    writeFileSync(
      join(rootDir, '.pcp', 'config.json'),
      JSON.stringify({
        agentMapping: {
          'claude-code': 'wren',
          codex: 'lumen',
          gemini: 'aster',
        },
      })
    );

    expect(resolveAgentId(undefined, 'codex')).toBe('lumen');
    expect(resolveAgentId(undefined, 'gemini')).toBe('aster');
    expect(resolveAgentId(undefined, 'claude')).toBe('wren');
  });
});

