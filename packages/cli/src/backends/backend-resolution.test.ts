/**
 * The four-level precedence for choosing a backend.
 *
 * Every level is exercised, and so is every boundary between them. The task
 * that filed this said why: "A default that silently loses to a stale global
 * default would look identical to working, from one test." Testing only
 * `ink -a lumen` in an empty directory would pass against an implementation
 * where the agent layer never runs at all, because 'codex' could equally have
 * come from somewhere else.
 *
 * So each test below makes the layers DISAGREE, and asserts which one won.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const lookupAgentBackend = vi.fn();
vi.mock('./agent-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-backend.js')>();
  return { ...actual, lookupAgentBackend: (...args: unknown[]) => lookupAgentBackend(...args) };
});

const { resolveBackend } = await import('./identity.js');

let dir: string;
let originalCwd: string;

function writeIdentityJson(backend: string) {
  mkdirSync(join(dir, '.ink'), { recursive: true });
  writeFileSync(
    join(dir, '.ink', 'identity.json'),
    JSON.stringify({ sbSlug: 'wren', studioId: 'main', backend }),
    'utf-8'
  );
}

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'ink-backend-res-'));
  process.chdir(dir);
  lookupAgentBackend.mockReset();
  lookupAgentBackend.mockResolvedValue({ source: 'none' });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveBackend precedence', () => {
  it('1. -b wins over everything, and does not even ask the agent', async () => {
    writeIdentityJson('gemini');
    lookupAgentBackend.mockResolvedValue({ backend: 'codex', source: 'cache' });

    const r = await resolveBackend({ cliBackend: 'claude', agentSlug: 'lumen' });

    expect(r).toEqual({ backend: 'claude', source: 'flag' });
    expect(lookupAgentBackend).not.toHaveBeenCalled();
  });

  it("2. the agent's own backend beats the directory's", async () => {
    // This is the reported bug: `ink -a lumen` inside a studio whose
    // identity.json says claude used to start claude.
    writeIdentityJson('claude');
    lookupAgentBackend.mockResolvedValue({ backend: 'codex', source: 'cache' });

    const r = await resolveBackend({ agentSlug: 'lumen' });

    expect(r).toEqual({ backend: 'codex', source: 'agent' });
  });

  it('3. identity.json is used when no agent was named', async () => {
    writeIdentityJson('codex');

    const r = await resolveBackend({});

    expect(r).toEqual({ backend: 'codex', source: 'identity-json', note: undefined });
    expect(lookupAgentBackend).not.toHaveBeenCalled();
  });

  it('3b. identity.json is used when the agent has no recorded backend', async () => {
    writeIdentityJson('codex');
    lookupAgentBackend.mockResolvedValue({ source: 'none' });

    const r = await resolveBackend({ agentSlug: 'nobody' });

    expect(r.backend).toBe('codex');
    expect(r.source).toBe('identity-json');
  });

  it('4. claude is the last resort, with nothing else available', async () => {
    const r = await resolveBackend({});
    expect(r).toEqual({ backend: 'claude', source: 'default', note: undefined });
  });

  it('names the unrunnable backend rather than silently substituting', async () => {
    // aster's record says 'antigravity'. Falling back is fine; doing it
    // quietly is how someone spends an hour wondering why Aster sounds
    // like Claude.
    lookupAgentBackend.mockResolvedValue({ source: 'cache', unrunnable: 'antigravity' });

    const r = await resolveBackend({ agentSlug: 'aster' });

    expect(r.backend).toBe('claude');
    expect(r.source).toBe('default');
    expect(r.note).toContain('antigravity');
    expect(r.note).toContain('aster');
    expect(r.note).toContain('-b');
  });

  it('carries that note through the identity.json fallback too', async () => {
    writeIdentityJson('codex');
    lookupAgentBackend.mockResolvedValue({ source: 'cache', unrunnable: 'antigravity' });

    const r = await resolveBackend({ agentSlug: 'aster' });

    expect(r.backend).toBe('codex');
    expect(r.note).toContain('antigravity');
  });

  it('says nothing when the agent resolved cleanly', async () => {
    lookupAgentBackend.mockResolvedValue({ backend: 'codex', source: 'cache' });
    const r = await resolveBackend({ agentSlug: 'lumen' });
    expect(r.note).toBeUndefined();
  });

  it('passes the slug through to the lookup unchanged', async () => {
    await resolveBackend({ agentSlug: 'Lumen' });
    expect(lookupAgentBackend).toHaveBeenCalledWith('Lumen');
  });
});
