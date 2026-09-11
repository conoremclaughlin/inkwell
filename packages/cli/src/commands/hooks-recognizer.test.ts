/**
 * isPcpHookCommand decides whether an existing hook line is Inkwell-managed.
 * Two writers produce those lines: `ink hooks install` (this CLI, which pins
 * its own node binary and cli.js) and the server's studio settings generator
 * (`node <checkout>/packages/cli/dist/cli.js hooks ...`). Recognition is by
 * shape — an ink entrypoint, then `hooks`, then a hook name — so a hook name
 * added by either writer never reads as a conflict (Lumen, PR #611: the
 * server's on-tool-approval hook was missing from a hard-coded name list).
 */

import { describe, it, expect } from 'vitest';
import { isPcpHookCommand } from './hooks.js';

const SERVER_HOOK_NAMES = [
  'pre-compact',
  'post-compact',
  'on-session-start',
  'on-tool-approval',
  'on-prompt',
  'on-stop',
];

describe('isPcpHookCommand', () => {
  it('accepts every hook the server generates, in the form the server writes', () => {
    for (const name of SERVER_HOOK_NAMES) {
      const line = `node /srv/checkout/packages/cli/dist/cli.js hooks ${name} --backend claude-code`;
      expect(isPcpHookCommand(line), line).toBe(true);
    }
  });

  it('accepts a hook name neither writer knows yet', () => {
    expect(isPcpHookCommand('ink hooks on-some-future-event --backend claude-code')).toBe(true);
    expect(
      isPcpHookCommand(
        'node /srv/checkout/packages/cli/dist/cli.js hooks on-some-future-event --backend codex'
      )
    ).toBe(true);
  });

  it('accepts the form this CLI writes: a pinned node binary and cli.js, single-quoted when needed', () => {
    expect(
      isPcpHookCommand(
        '/Users/o/.nvm/versions/node/v22.21.0/bin/node /Users/o/ws/ink/packages/cli/dist/cli.js hooks on-stop --backend claude-code'
      )
    ).toBe(true);
    expect(
      isPcpHookCommand(
        "'/Users/o b/.nvm/versions/node/v22.21.0/bin/node' '/Users/o b/ws/ink/packages/cli/dist/cli.js' hooks on-prompt --backend claude-code"
      )
    ).toBe(true);
    expect(
      isPcpHookCommand(
        '/Users/o/ws/ink/node_modules/.bin/ink hooks pre-compact --backend claude-code'
      )
    ).toBe(true);
  });

  it('accepts the server form with a double-quoted whitespace path', () => {
    expect(
      isPcpHookCommand(
        'node "/Users/o b/ink/packages/cli/dist/cli.js" hooks on-tool-approval --backend claude-code'
      )
    ).toBe(true);
  });

  it('accepts bare ink, a path to ink, and an agent-suffixed ink', () => {
    expect(isPcpHookCommand('ink hooks on-session-start --backend claude-code')).toBe(true);
    expect(isPcpHookCommand('/Users/o/.local/bin/ink hooks post-compact --backend gemini')).toBe(
      true
    );
    expect(isPcpHookCommand('ink-lumen hooks on-stop --backend codex')).toBe(true);
  });

  it('rejects hooks that are not ours', () => {
    expect(isPcpHookCommand(undefined)).toBe(false);
    expect(isPcpHookCommand('')).toBe(false);
    expect(isPcpHookCommand('custom-tool cleanup')).toBe(false);
    expect(isPcpHookCommand('echo hooks on-prompt')).toBe(false);
    expect(isPcpHookCommand('node /opt/other/tool.js hooks on-prompt --backend claude-code')).toBe(
      false
    );
    expect(isPcpHookCommand('hooks on-prompt --backend claude-code')).toBe(false);
    expect(isPcpHookCommand('ink hooks')).toBe(false);
    expect(isPcpHookCommand('ink hooks --backend claude-code')).toBe(false);
    expect(isPcpHookCommand('my-ink-thing hooks on-prompt')).toBe(false);
  });
});
