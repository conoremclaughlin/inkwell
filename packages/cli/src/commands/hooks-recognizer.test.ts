/**
 * isInkHookCommand decides whether an existing hook line is Inkwell-managed.
 * Two writers produce those lines: `ink hooks install` (this CLI, which pins
 * its own node binary and cli.js) and the server's studio settings generator
 * (`node <checkout>/packages/cli/dist/cli.js hooks ...`). Recognition is by
 * shape — an ink entrypoint, then `hooks`, then a hook name — so a hook name
 * added by either writer never reads as a conflict (Lumen, PR #611: the
 * server's on-tool-approval hook was missing from a hard-coded name list).
 */

import { describe, it, expect } from 'vitest';
import { isInkHookCommand } from './hooks.js';

const SERVER_HOOK_NAMES = [
  'pre-compact',
  'post-compact',
  'on-session-start',
  'on-tool-approval',
  'on-prompt',
  'on-stop',
];

describe('isInkHookCommand', () => {
  it('accepts every hook the server generates, in the form the server writes', () => {
    for (const name of SERVER_HOOK_NAMES) {
      const line = `node /srv/checkout/packages/cli/dist/cli.js hooks ${name} --backend claude-code`;
      expect(isInkHookCommand(line), line).toBe(true);
    }
  });

  it('accepts a hook name neither writer knows yet', () => {
    expect(isInkHookCommand('ink hooks on-some-future-event --backend claude-code')).toBe(true);
    expect(
      isInkHookCommand(
        'node /srv/checkout/packages/cli/dist/cli.js hooks on-some-future-event --backend codex'
      )
    ).toBe(true);
  });

  it('accepts the form this CLI writes: a pinned node binary and cli.js, single-quoted when needed', () => {
    expect(
      isInkHookCommand(
        '/Users/o/.nvm/versions/node/v22.21.0/bin/node /Users/o/ws/ink/packages/cli/dist/cli.js hooks on-stop --backend claude-code'
      )
    ).toBe(true);
    expect(
      isInkHookCommand(
        "'/Users/o b/.nvm/versions/node/v22.21.0/bin/node' '/Users/o b/ws/ink/packages/cli/dist/cli.js' hooks on-prompt --backend claude-code"
      )
    ).toBe(true);
    expect(
      isInkHookCommand(
        '/Users/o/ws/ink/node_modules/.bin/ink hooks pre-compact --backend claude-code'
      )
    ).toBe(true);
  });

  it('accepts the server form with a double-quoted whitespace path', () => {
    expect(
      isInkHookCommand(
        'node "/Users/o b/ink/packages/cli/dist/cli.js" hooks on-tool-approval --backend claude-code'
      )
    ).toBe(true);
  });

  it('accepts bare ink, a path to ink, and an agent-suffixed ink', () => {
    expect(isInkHookCommand('ink hooks on-session-start --backend claude-code')).toBe(true);
    expect(isInkHookCommand('/Users/o/.local/bin/ink hooks post-compact --backend gemini')).toBe(
      true
    );
    expect(isInkHookCommand('ink-lumen hooks on-stop --backend codex')).toBe(true);
  });

  it('accepts any launcher when the line carries the managed marker the server writes', () => {
    expect(
      isInkHookCommand('/opt/tools/launch-ink hooks on-prompt --backend claude-code # ink-managed')
    ).toBe(true);
    expect(
      isInkHookCommand(
        'node /opt/tools/entry.mjs hooks on-tool-approval --backend claude-code # ink-managed'
      )
    ).toBe(true);
    expect(
      isInkHookCommand(
        'node "/Users/o b/tools/entry.mjs" hooks on-stop --backend claude-code # ink-managed'
      )
    ).toBe(true);
  });

  it('does not let the marker stand in for the managed grammar', () => {
    expect(isInkHookCommand('custom-tool audit # ink-managed')).toBe(false);
    expect(isInkHookCommand('/opt/tools/launch-ink hooks # ink-managed')).toBe(false);
    expect(
      isInkHookCommand(
        '/opt/tools/launch-ink hooks on-prompt --backend claude-code # ink-managed-by-me'
      )
    ).toBe(false);
    expect(
      isInkHookCommand('/opt/tools/launch-ink # ink-managed hooks on-prompt --backend claude-code')
    ).toBe(false);
  });

  it('preserves an unrelated CLI that merely shares the command shape', () => {
    expect(
      isInkHookCommand('node /opt/project/scripts/cli.js hooks audit --backend claude-code')
    ).toBe(false);
    expect(
      isInkHookCommand(
        '/usr/local/bin/node /opt/project/scripts/cli.js hooks on-prompt --backend claude-code'
      )
    ).toBe(false);
  });

  it('rejects hooks that are not ours', () => {
    expect(isInkHookCommand(undefined)).toBe(false);
    expect(isInkHookCommand('')).toBe(false);
    expect(isInkHookCommand('custom-tool cleanup')).toBe(false);
    expect(isInkHookCommand('echo hooks on-prompt')).toBe(false);
    expect(isInkHookCommand('node /opt/other/tool.js hooks on-prompt --backend claude-code')).toBe(
      false
    );
    expect(isInkHookCommand('hooks on-prompt --backend claude-code')).toBe(false);
    expect(isInkHookCommand('ink hooks')).toBe(false);
    expect(isInkHookCommand('ink hooks --backend claude-code')).toBe(false);
    expect(isInkHookCommand('my-ink-thing hooks on-prompt')).toBe(false);
  });
});
