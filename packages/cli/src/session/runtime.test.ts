import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readRuntimeState, upsertRuntimeSession } from './runtime.js';

describe('runtime session linkage', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pcp-runtime-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('preserves runtimeLinkId and accumulates backend session ids', () => {
    upsertRuntimeSession(cwd, {
      pcpSessionId: 'pcp-1',
      backend: 'codex',
      agentId: 'lumen',
      runtimeLinkId: 'link-1',
    });

    upsertRuntimeSession(cwd, {
      pcpSessionId: 'pcp-1',
      backend: 'codex',
      agentId: 'lumen',
      backendSessionId: 'backend-a',
    });

    upsertRuntimeSession(cwd, {
      pcpSessionId: 'pcp-1',
      backend: 'codex',
      agentId: 'lumen',
      backendSessionId: 'backend-b',
    });

    const state = readRuntimeState(cwd);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].runtimeLinkId).toBe('link-1');
    expect(state.sessions[0].backendSessionId).toBe('backend-b');
    expect(state.sessions[0].backendSessionIds).toEqual(['backend-a', 'backend-b']);
  });

  it('de-duplicates backend session ids when the same id is seen multiple times', () => {
    upsertRuntimeSession(cwd, {
      pcpSessionId: 'pcp-1',
      backend: 'claude',
      agentId: 'lumen',
      backendSessionId: 'sess-1',
    });
    upsertRuntimeSession(cwd, {
      pcpSessionId: 'pcp-1',
      backend: 'claude',
      agentId: 'lumen',
      backendSessionId: 'sess-1',
      backendSessionIds: ['sess-1'],
    });

    const state = readRuntimeState(cwd);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].backendSessionIds).toEqual(['sess-1']);
  });
});

