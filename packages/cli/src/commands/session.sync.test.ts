import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveSyncWorkspaceId } from './session.js';

describe('resolveSyncWorkspaceId', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers an explicit workspace id over local identity.json', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pcp-session-sync-'));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, '.pcp'), { recursive: true });
    writeFileSync(
      join(cwd, '.pcp', 'identity.json'),
      JSON.stringify({ workspaceId: 'workspace-from-file' })
    );

    expect(resolveSyncWorkspaceId('workspace-from-flag', cwd)).toBe('workspace-from-flag');
  });

  it('falls back to workspaceId from .pcp/identity.json', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pcp-session-sync-'));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, '.pcp'), { recursive: true });
    writeFileSync(
      join(cwd, '.pcp', 'identity.json'),
      JSON.stringify({ workspaceId: 'workspace-from-file' })
    );

    expect(resolveSyncWorkspaceId(undefined, cwd)).toBe('workspace-from-file');
  });

  it('supports canonical studioId-only identity files', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pcp-session-sync-'));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, '.pcp'), { recursive: true });
    writeFileSync(
      join(cwd, '.pcp', 'identity.json'),
      JSON.stringify({ studioId: 'studio-from-file' })
    );

    expect(resolveSyncWorkspaceId(undefined, cwd)).toBe('studio-from-file');
  });
});
