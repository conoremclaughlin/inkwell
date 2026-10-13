/**
 * What an inkling's turn can read through ink's own tools (task 0321ccf1).
 *
 * With the provider's tools withheld (backend-runner.ts), every read an
 * inkling's turn makes is one of ink's, dispatched as `ink chat` dispatches
 * it: the inkling profile's policy, then the local dispatcher, from the
 * inkling's own folder as the working directory. This drives that path over
 * a synthetic home holding what must stay out of reach: a studio checkout's
 * .env.local (the root checkout's names the server's service key), another
 * checkout's, the shared ~/.ink/files, another upload, and a link inside the
 * folder that points out of it.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callPiTool } from './pi-tools.js';
import { executeToolCalls } from './tool-call-executor.js';
import { createLocalToolDispatcher } from './tool-dispatch.js';
import { applyLaunchProfile } from './tool-profiles.js';
import { ToolPolicyState } from './tool-policy.js';

const MARKER = 'PROBE_MARKER=never-readable-0a1b';

describe("an inkling's turn reads only its own folder (task 0321ccf1)", () => {
  let home: string;
  let folder: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'inkling-read-boundary-')));
    folder = join(home, '.ink', 'inklings', 'kindle-0a1b2c3d');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'own.txt'), 'the inkling’s own note\n');
    const plant = (path: string): void => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, `${MARKER}\n`);
    };
    plant(join(home, '.ink', 'studios', 'some-studio', '.env.local'));
    plant(join(home, 'ws', 'repo', '.env.local'));
    plant(join(home, '.ink', 'files', 'telegram', 'note.txt'));
    plant(join(home, '.ink', 'uploads', 'u', 'w', 'up2', 'up2.txt'));
    symlinkSync(
      join(home, '.ink', 'studios', 'some-studio', '.env.local'),
      join(folder, 'linked.txt')
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function inklingPolicy(): ToolPolicyState {
    // The machine's grants on 2026-10-07, which the profile must override.
    const policyPath = join(home, 'tool-policy.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        version: 2,
        scopes: {
          global: { mode: 'backend', permanentGrants: ['bash', 'send_response', 'send_to_inbox'] },
        },
      })
    );
    const policy = new ToolPolicyState('backend', { policyPath, persist: false });
    policy.setContext({ sbSlug: 'kindle-0a1b2c3d' });
    policy.setMutationScope('agent');
    expect(applyLaunchProfile(policy, 'tools')).toMatchObject({
      ok: true,
      withholdProviderTools: true,
    });
    return policy;
  }

  async function run(calls: Array<{ tool: string; args: Record<string, unknown> }>) {
    const callInk = vi.fn().mockResolvedValue({ success: true });
    const promptForApproval = vi.fn().mockResolvedValue(true);
    const results = await executeToolCalls(
      calls.map((c) => ({ ...c, raw: '' })),
      {
        policy: inklingPolicy(),
        sessionId: 'synthetic-session',
        commitIntent: vi.fn().mockResolvedValue(undefined),
        promptForApproval,
        callTool: createLocalToolDispatcher({
          cwd: folder,
          callPi: callPiTool,
          callInk,
          resolveCredentials: (args) => args,
        }),
      }
    );
    return { results, callInk, promptForApproval };
  }

  it('reads a file of its own (the control)', async () => {
    const { results } = await run([{ tool: 'read', args: { path: 'own.txt' } }]);
    expect(results[0]!.status).toBe('executed');
    expect(JSON.stringify(results)).toContain('own note');
  });

  it('never reads a studio .env.local, the shared files, another upload or a link out of its folder', async () => {
    const studioEnv = join(home, '.ink', 'studios', 'some-studio', '.env.local');
    const calls = [
      { tool: 'read', args: { path: studioEnv } },
      { tool: 'read', args: { path: '../../studios/some-studio/.env.local' } },
      { tool: 'read', args: { path: join(home, 'ws', 'repo', '.env.local') } },
      { tool: 'read', args: { path: join(home, '.ink', 'files', 'telegram', 'note.txt') } },
      { tool: 'read', args: { path: join(home, '.ink', 'uploads', 'u', 'w', 'up2', 'up2.txt') } },
      { tool: 'read', args: { path: 'linked.txt' } },
      { tool: 'read', args: { file_path: studioEnv } },
      { tool: 'grep', args: { pattern: 'PROBE', path: join(home, '.ink', 'studios') } },
      { tool: 'grep', args: { pattern: 'PROBE', path: '../..' } },
      { tool: 'find', args: { pattern: '.env*', path: home } },
      { tool: 'ls', args: { path: join(home, '.ink', 'files') } },
      { tool: 'view_image', args: { path: join(home, '.ink', 'files', 'telegram', 'note.txt') } },
      { tool: 'bash', args: { command: `cat ${studioEnv}` } },
    ];
    const { results, callInk, promptForApproval } = await run(calls);
    expect(results).toHaveLength(calls.length);
    // Each for its own reason, not an incidental failure (a missing ripgrep,
    // say): the path tools are held to the folder, the rest are denied.
    results.forEach((result, i) => {
      const label = JSON.stringify(calls[i]);
      if (['view_image', 'bash'].includes(result.tool)) {
        expect(result.status, label).toBe('blocked');
        expect(result.reason, label).toBe('Tool is explicitly denied by policy.');
      } else {
        expect(result.status, label).toBe('error');
        expect(result.error, label).toMatch(/^Path containment violation: /);
      }
    });
    expect(JSON.stringify(results)).not.toContain('never-readable');
    // Refused outright: nothing was asked, and nothing went to the server instead.
    expect(promptForApproval).not.toHaveBeenCalled();
    expect(callInk).not.toHaveBeenCalled();
  });
});
