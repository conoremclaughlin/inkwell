import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  admitsCodexMailHook,
  createCodexMailHookBinding,
  CODEX_MAIL_BINDING_ENV,
} from './hook-binding.js';

const bindings: ReturnType<typeof createCodexMailHookBinding>[] = [];
afterEach(() => {
  for (const binding of bindings.splice(0)) binding.dispose();
});
function fixture() {
  const scope = {
    sessionId: 'fixture-session',
    studioId: 'fixture-studio',
    sbSlug: 'fixture',
    // Runtime options are structurally assignable to Scope; never serialize
    // their env/arguments into the binding file.
    env: { FIXTURE_ONLY: 'must-not-be-persisted' },
    args: ['fixture-only'],
  };
  const binding = createCodexMailHookBinding(scope);
  bindings.push(binding);
  const env = {
    ...binding.env,
    INK_CODEX_INKMAIL: '1',
    INK_SESSION_ID: scope.sessionId,
    INK_STUDIO_ID: scope.studioId,
    SB_SLUG: scope.sbSlug,
    INK_CONTEXT: Buffer.from(
      JSON.stringify({ ...scope, cliAttached: true, runtime: 'codex' })
    ).toString('base64url'),
  };
  return { binding, env, path: binding.env[CODEX_MAIL_BINDING_ENV] };
}
describe('exact native thread hook binding', () => {
  it('refuses pre-bind startup; admits only the published thread, never an inherited foreign thread', () => {
    const { binding, env, path } = fixture();
    const parent = { session_id: 'parent-thread' };
    expect(admitsCodexMailHook(parent, env)).toBe(false);
    binding.bind('parent-thread');
    expect(admitsCodexMailHook(parent, env)).toBe(true);
    for (const payload of [
      {},
      { sessionId: 'parent-thread' },
      { session_id: 'nested-exec' },
      { session_id: 'subagent' },
      { session_id: 'parent-thread', agent_id: 'subagent' },
      { session_id: 'parent-thread', agent_id: null },
      { session_id: 'parent-thread', agent_type: 'default' },
      { session_id: 'parent-thread', agent_transcript_path: '/fixture/subagent' },
    ]) {
      expect(admitsCodexMailHook(payload, env)).toBe(false);
    }
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      sessionId: 'fixture-session',
      studioId: 'fixture-studio',
      sbSlug: 'fixture',
      threadId: 'parent-thread',
      ownerPid: process.pid,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    binding.bind('parent-thread'); // Same binding is idempotent.
    expect(() => binding.bind('other')).toThrow('cannot change');
    binding.revoke();
    expect(admitsCodexMailHook(parent, env)).toBe(false);
    expect(() => binding.bind('parent-thread')).toThrow('revoked');
  });
  it('refuses mismatched scope, corrupt/missing binding, or invalid owner PID', () => {
    const { binding, env, path } = fixture();
    binding.bind('parent-thread');
    const original = JSON.parse(readFileSync(path, 'utf8'));
    for (const bad of [
      { ...original, sessionId: 'other' },
      { ...original, studioId: 'other' },
      { ...original, sbSlug: 'other' },
      { ...original, ownerPid: 0 },
      null,
    ]) {
      writeFileSync(path, JSON.stringify(bad));
      expect(admitsCodexMailHook({ session_id: 'parent-thread' }, env)).toBe(false);
    }
    writeFileSync(path, 'malformed');
    expect(admitsCodexMailHook({ session_id: 'parent-thread' }, env)).toBe(false);
    expect(
      admitsCodexMailHook(
        { session_id: 'parent-thread' },
        { ...env, [CODEX_MAIL_BINDING_ENV]: undefined }
      )
    ).toBe(false);
  });
});
