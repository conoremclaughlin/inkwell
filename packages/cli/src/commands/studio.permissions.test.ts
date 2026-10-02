/**
 * `ink studio create` and `ink studio setup` and the main worktree's
 * Claude permissions (design v3, item 3). Inheritance is opt-in on every
 * path: the interactive confirm defaults to no and `.claude` is not
 * pre-checked; a named create and a setup inherit only with
 * --inherit-claude-permissions; the `.claude` copy leaves
 * settings.local.json behind, so the completion routine never finds the
 * main worktree's lane rules already sitting in the studio (where it would
 * rightly keep them as authored policy). The create and setup paths run
 * end to end: a real temporary repository, a real `git worktree add`, the
 * real copy and the real completion routine, with the server calls stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Command } from 'commander';
import * as shared from '@inklabs/shared';
// A namespace import: against a tree without the exported helpers, each
// test that needs one fails on its own instead of the file failing to load.
import * as studioCommands from './studio.js';

/** The prompts answer with their defaults, as pressing enter would. */
const prompts = vi.hoisted(() => ({
  confirmDefaults: [] as Array<boolean | undefined>,
  checkboxChoices: [] as Array<Array<{ value: string; checked?: boolean }>>,
}));
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(async (cfg: { default?: string }) => cfg.default ?? ''),
  checkbox: vi.fn(async (cfg: { choices: Array<{ value: string; checked?: boolean }> }) => {
    prompts.checkboxChoices.push(cfg.choices);
    return cfg.choices.filter((c) => c.checked).map((c) => c.value);
  }),
  confirm: vi.fn(async (cfg: { default?: boolean }) => {
    prompts.confirmDefaults.push(cfg.default);
    return cfg.default ?? false;
  }),
}));

const STUDIO_ID = '191b7705-85bd-4c76-b622-43f655bf7fd6';
const LANE_RULES = { allow: ['Edit(//repo/packages/**)'], deny: ['Bash(git commit *)'] };

let root: string;
let main: string;

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
const deps = () => ({
  gitRoot: main,
  register: vi.fn(async () => STUDIO_ID),
  syncSkills: vi.fn(async () => ({ label: 'skills sync', status: 'skipped' as const })),
});

beforeEach(() => {
  prompts.confirmDefaults.length = 0;
  prompts.checkboxChoices.length = 0;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-perms-cli-')));
  main = join(root, 'repo');
  mkdirSync(main);
  git(['init', '-q', '-b', 'main'], main);
  git(
    [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'root',
    ],
    main
  );
  writeFileSync(
    join(main, '.mcp.json'),
    JSON.stringify({ mcpServers: { inkwell: { type: 'http', url: 'http://localhost:3001/mcp' } } })
  );
  mkdirSync(join(main, '.claude', 'commands'), { recursive: true });
  writeFileSync(
    join(main, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: LANE_RULES })
  );
  writeFileSync(join(main, '.claude', 'commands', 'review.md'), '# a command\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the interactive create flow defaults to no inheritance', () => {
  it('.claude is offered unchecked and the inherit confirm defaults to no', async () => {
    const result = await studioCommands.runInteractiveFlow('wren', main);
    expect(prompts.checkboxChoices[0]?.find((c) => c.value === '.claude')?.checked).toBe(false);
    expect(prompts.confirmDefaults).toEqual([false]);
    expect(result.configDirs).not.toContain('.claude');
    expect(result.inheritClaudePermissions).toBe(false);
  });
});

describe('the create and setup flags: inheritance only when asked', () => {
  async function parse(args: string[]): Promise<Record<string, unknown>> {
    const program = new Command();
    program.exitOverride();
    studioCommands.registerStudioCommands(program);
    const studio = program.commands.find((c) => c.name() === 'studio')!;
    let captured: Record<string, unknown> = {};
    for (const name of ['create', 'setup']) {
      studio.commands
        .find((c) => c.name() === name)!
        .action((...actionArgs: unknown[]) => {
          captured = actionArgs.find(
            (a) => a && typeof a === 'object' && !(a instanceof Command)
          ) as Record<string, unknown>;
        });
    }
    await program.parseAsync(['node', 'ink', 'studio', ...args]);
    return captured;
  }

  it('a named create with no flag does not inherit', async () => {
    expect((await parse(['create', 'alpha'])).inheritClaudePermissions).not.toBe(true);
  });

  it('setup with no flag does not inherit', async () => {
    expect((await parse(['setup', 'wren'])).inheritClaudePermissions).not.toBe(true);
  });

  it('--inherit-claude-permissions opts in, on both; the old negative still parses', async () => {
    expect(
      (await parse(['create', 'alpha', '--inherit-claude-permissions'])).inheritClaudePermissions
    ).toBe(true);
    expect(
      (await parse(['setup', 'wren', '--inherit-claude-permissions'])).inheritClaudePermissions
    ).toBe(true);
    expect(
      (await parse(['create', 'alpha', '--no-inherit-claude-permissions'])).inheritClaudePermissions
    ).toBe(false);
  });
});

describe('create, end to end: the .claude copy plus the completion routine', () => {
  const settingsOf = (name: string) =>
    readJson(join(root, `repo--${name}`, '.claude', 'settings.local.json'));

  it('copying .claude brings its other files, not the lane rules; the studio gets the builder profile', async () => {
    await studioCommands.createStudioInner(
      'alpha',
      { agent: 'wren', copyConfig: true, configDirs: '.claude', install: false },
      undefined,
      deps()
    );
    const studio = join(root, 'repo--alpha');
    expect(existsSync(join(studio, '.claude', 'commands', 'review.md'))).toBe(true);
    expect(settingsOf('alpha').permissions).toEqual(
      shared.studioPermissionRules('builder', 'wren')
    );
    expect(JSON.stringify(settingsOf('alpha'))).not.toContain('//repo/packages');
  });

  it('the interactive answers (no .claude, no inheritance) give the builder profile too', async () => {
    const answers = await studioCommands.runInteractiveFlow('wren', main);
    await studioCommands.createStudioInner(
      'beta',
      { agent: 'wren', install: false, inheritClaudePermissions: answers.inheritClaudePermissions },
      { configDirsList: answers.configDirs },
      deps()
    );
    expect(settingsOf('beta').permissions).toEqual(shared.studioPermissionRules('builder', 'wren'));
  });

  it('with --inherit-claude-permissions the lane rules are copied, on purpose', async () => {
    await studioCommands.createStudioInner(
      'gamma',
      {
        agent: 'wren',
        copyConfig: true,
        configDirs: '.claude',
        install: false,
        inheritClaudePermissions: true,
      },
      undefined,
      deps()
    );
    expect(settingsOf('gamma').permissions).toEqual(LANE_RULES);
  });
});

describe('setup, end to end: all three studios get the builder profile unless asked', () => {
  it('no flag: review, build and product studios each get the builder profile', async () => {
    await studioCommands.setupStudios('wren', {}, deps());
    for (const suffix of ['review', 'build', 'product']) {
      const settings = readJson(
        join(root, `repo--wren-${suffix}`, '.claude', 'settings.local.json')
      );
      expect(settings.permissions, suffix).toEqual(shared.studioPermissionRules('builder', 'wren'));
    }
  });

  it('--inherit-claude-permissions: each copies the lane rules', async () => {
    await studioCommands.setupStudios('wren', { inheritClaudePermissions: true }, deps());
    for (const suffix of ['review', 'build', 'product']) {
      const settings = readJson(
        join(root, `repo--wren-${suffix}`, '.claude', 'settings.local.json')
      );
      expect(settings.permissions, suffix).toEqual(LANE_RULES);
    }
  });
});
