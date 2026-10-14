/**
 * Claude Code accepts the launch files we generate (spec
 * automated-turn-permissions §3.3), measured with `claude doctor`: no model
 * call and no session, and an isolated CLAUDE_CONFIG_DIR. A rule it rejects
 * is reported under "Invalid settings" and skipped, which for a deny is a
 * rule that silently stops applying.
 *
 * Opt-in, because it needs the `claude` binary: CLAUDE_DOCTOR_PROBE=1.
 * Measured on 2.1.296, 2026-10-13: every automated, builder and reviewer
 * rule accepted; the malformed control reported.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as shared from '@inklabs/shared';

const run = promisify(execFile);
const enabled = process.env.CLAUDE_DOCTOR_PROBE === '1';

describe.skipIf(!enabled)('claude doctor accepts every generated launch rule', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-doctor-probe-'));
    mkdirSync(join(dir, 'cfg'));
    mkdirSync(join(dir, 'cwd'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function doctor(permissions: unknown): Promise<string> {
    const file = join(dir, `settings-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify({ permissions }));
    const { stdout, stderr } = await run('claude', ['--settings', file, 'doctor'], {
      cwd: join(dir, 'cwd'),
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'cfg') },
      timeout: 120_000,
    });
    return stdout + stderr;
  }

  it('control: a malformed rule is reported invalid', async () => {
    const out = await doctor({ allow: ['Bash(git push --force'], deny: [] });
    expect(out).toContain('Invalid settings');
  });

  it.each([
    [
      'automated, no studio',
      shared.automatedLaunchRules({ mcpServers: ['inkwell', 'playwright'] }),
    ],
    [
      'automated reviewer',
      shared.automatedLaunchRules({
        profile: 'reviewer',
        owner: 'wren',
        mcpServers: ['inkwell', 'github'],
      }),
    ],
    ['builder', shared.studioPermissionRules('builder', 'wren')],
    ['reviewer', shared.studioPermissionRules('reviewer', 'wren')],
  ])('%s: nothing reported invalid', async (_name, rules) => {
    const out = await doctor(rules);
    expect(out).not.toContain('Invalid settings');
  });
});
