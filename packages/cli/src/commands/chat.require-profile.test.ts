/**
 * `ink chat --require-profile` (task 0321ccf1, Lumen #773).
 *
 * The server names an inkling's profile with --require-profile because a CLI
 * built before the option existed must refuse the turn, not run it: such a
 * CLI took `--profile inkling`, warned that it did not know the name, and
 * carried on unbounded. What makes the old CLI refuse is Commander rejecting
 * an option the chat command does not declare, before its action runs. The
 * root program allows unknown options (for backend passthrough), so this pins
 * that the chat command does not inherit that, the way cli.ts builds it.
 */

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerChatCommand } from './chat.js';

function chatCommand(): { program: Command; chat: Command } {
  // As cli.ts builds the root program.
  const program = new Command()
    .name('ink')
    .enablePositionalOptions()
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .exitOverride();
  registerChatCommand(program);
  const chat = program.commands.find((c) => c.name() === 'chat');
  if (!chat) throw new Error('chat command not registered');
  chat.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  return { program, chat };
}

describe('ink chat --require-profile', () => {
  it('is an option the chat declares', () => {
    expect(chatCommand().chat.options.map((o) => o.long)).toContain('--require-profile');
  });

  it('refuses an option it does not declare before anything runs, under a root that allows them', async () => {
    const { program, chat } = chatCommand();
    let ran = false;
    chat.action(() => {
      ran = true;
    });
    await expect(
      program.parseAsync(['node', 'ink', 'chat', '--an-option-from-a-later-cli', 'x'])
    ).rejects.toMatchObject({ code: 'commander.unknownOption' });
    expect(ran).toBe(false);
  });
});

describe('ink chat --no-provider-tools (task 0321ccf1)', () => {
  it('reaches the action as providerTools: false, and is absent (true) otherwise', async () => {
    const seen: Array<Record<string, unknown>> = [];
    for (const argv of [
      ['chat', '--require-profile', 'inkling', '--no-provider-tools', '--away'],
      ['chat', '--profile', 'safe', '--away'],
    ]) {
      const { program, chat } = chatCommand();
      chat.action((options: Record<string, unknown>) => {
        seen.push(options);
      });
      await program.parseAsync(['node', 'ink', ...argv]);
    }
    expect(seen[0]).toMatchObject({ requireProfile: 'inkling', providerTools: false });
    expect(seen[1]).toMatchObject({ profile: 'safe', providerTools: true });
  });
});
