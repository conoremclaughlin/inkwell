/**
 * `ink permissions sync` (task cd2fe361): bring an existing studio's Claude
 * settings up to its permission profile, additively.
 *
 * Pinned here: only rules the profile has and the file lacks are added,
 * appended after the file's own rules in profile order; nothing is removed
 * or reordered, and every other setting is kept. A deny is not added when
 * it would refuse something the file allows by name, and an allow is not
 * added when the file denies or asks about that exact rule; both are
 * reported. A file already holding exactly the profile, one with no rules
 * at all (a reset), one with no permissions object, and one that cannot be
 * read are left as they are. A dry run writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { studioPermissionRules } from '@inklabs/shared';
import {
  denyRefusesNamedAllow,
  planProfileSync,
  syncStudioPermissions,
} from './permission-sync.js';

const builder = studioPermissionRules('builder', 'wren');
const reviewer = studioPermissionRules('reviewer', 'wren');

/**
 * What most studios made before the profiles carry: a copy of the main
 * worktree's lane rules, with allows named one by one and no denies.
 */
const ROOT_COPY = {
  allow: [
    'Read(*)',
    'Edit(//Users/someone/repo/**)',
    'Bash(git push:*)',
    'Bash(yarn install)',
    'mcp__github__create_pull_request',
    'mcp__inkwell__*',
  ],
  deny: [] as string[],
};

let root: string;
let settingsPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'permission-sync-'));
  settingsPath = join(root, '.claude', 'settings.local.json');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSettings(settings: unknown): string {
  mkdirSync(join(root, '.claude'), { recursive: true });
  const text = typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2) + '\n';
  writeFileSync(settingsPath, text);
  return text;
}
const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf-8'));
const sync = (apply: boolean, profile: 'builder' | 'reviewer' = 'builder', owner = 'wren') =>
  syncStudioPermissions(root, { profile, owner, apply });

describe('planProfileSync', () => {
  it('adds what the profile has and the file lacks, after the existing rules, in profile order', () => {
    const plan = planProfileSync(ROOT_COPY, builder);
    expect(plan.state).toBe('authored');
    expect(plan.addAllow).toEqual(builder.allow.filter((r) => !ROOT_COPY.allow.includes(r)));
    expect(plan.addAllow).toContain('mcp__playwright__*');
    expect(plan.addAllow).toContain('Bash(*)');
    expect(plan.addAllow).not.toContain('Read(*)');
    const permissions = plan.permissions as { allow: string[]; deny: string[] };
    expect(permissions.allow.slice(0, ROOT_COPY.allow.length)).toEqual(ROOT_COPY.allow);
    expect(permissions.allow.slice(ROOT_COPY.allow.length)).toEqual(plan.addAllow);
    expect(permissions.deny).toEqual(plan.addDeny);
  });

  it('does not add a deny that would refuse what the file allows by name, and says so', () => {
    // The reviewer still denies opening a PR, which the builder no longer
    // does, and denies every push, which the file allows in its legacy form.
    const plan = planProfileSync(ROOT_COPY, reviewer);
    expect(plan.addDeny).not.toContain('mcp__github__create_pull_request');
    expect(plan.kept.map((k) => k.rule).sort()).toEqual(
      ['Bash(git push *)', 'mcp__github__create_pull_request'].sort()
    );
    expect(plan.kept.every((k) => k.list === 'deny')).toBe(true);
    expect(plan.kept.find((k) => k.rule === 'Bash(git push *)')!.reason).toContain(
      'Bash(git push:*)'
    );
    // Every other deny is added: a broad allow does not block a backstop.
    expect(plan.addDeny).toEqual(
      reviewer.deny.filter(
        (r) => r !== 'mcp__github__create_pull_request' && r !== 'Bash(git push *)'
      )
    );
  });

  it('matches a deny only against an allow for the same tool', () => {
    const plan = planProfileSync({ allow: ['Edit(git push --force x)'], deny: [] }, builder);
    expect(plan.addDeny).toContain('Bash(git push --force *)');
    expect(plan.kept).toEqual([]);
  });

  it("appends after the file's own denies, keeping them", () => {
    const plan = planProfileSync({ allow: ['Read(*)'], deny: ['Bash(sudo *)'] }, builder);
    expect((plan.permissions as { deny: string[] }).deny).toEqual([
      'Bash(sudo *)',
      ...builder.deny,
    ]);
  });

  it('adds the backstops to a file whose grants are broad', () => {
    const plan = planProfileSync({ allow: ['Bash(*)', 'mcp__github__*'], deny: [] }, builder);
    expect(plan.addDeny).toEqual(builder.deny);
    expect(plan.kept).toEqual([]);
  });

  it('does not add an allow the file denies or asks about by name, and says so', () => {
    const plan = planProfileSync(
      { allow: [], deny: ['mcp__playwright__*'], ask: ['WebSearch'] },
      builder
    );
    expect(plan.addAllow).not.toContain('mcp__playwright__*');
    expect(plan.addAllow).not.toContain('WebSearch');
    expect(plan.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'mcp__playwright__*', list: 'allow' }),
        expect.objectContaining({ rule: 'WebSearch', list: 'allow' }),
      ])
    );
  });

  it('keeps every other key of the permissions object, in place', () => {
    const plan = planProfileSync(
      { defaultMode: 'acceptEdits', allow: ['Read(*)'], additionalDirectories: ['/tmp/x'] },
      builder
    );
    expect(Object.keys(plan.permissions)).toEqual([
      'defaultMode',
      'allow',
      'additionalDirectories',
      'deny',
    ]);
    expect(plan.permissions.defaultMode).toBe('acceptEdits');
    expect(plan.permissions.additionalDirectories).toEqual(['/tmp/x']);
  });

  it('reads exactly the profile as generated, with nothing to add', () => {
    const plan = planProfileSync(JSON.parse(JSON.stringify(builder)), builder);
    expect(plan.state).toBe('generated');
    expect(plan.addAllow).toEqual([]);
    expect(plan.addDeny).toEqual([]);
  });

  it('reads an object with no rules at all (a reset, or a mode alone) as no-rules', () => {
    expect(planProfileSync({}, builder).state).toBe('no-rules');
    expect(planProfileSync({ defaultMode: 'default' }, builder).state).toBe('no-rules');
    expect(planProfileSync({ allow: [], deny: [] }, builder).state).toBe('no-rules');
  });

  it('a superset of the profile is authored, with nothing to add', () => {
    const plan = planProfileSync(
      { allow: [...builder.allow, 'Bash(xcrun simctl *)'], deny: [...builder.deny] },
      builder
    );
    expect(plan.state).toBe('authored');
    expect(plan.addAllow).toEqual([]);
    expect(plan.addDeny).toEqual([]);
  });
});

describe('syncStudioPermissions', () => {
  it('dry run: reports the additions and writes nothing', () => {
    const before = writeSettings({ permissions: ROOT_COPY, enableAllProjectMcpServers: true });
    const result = sync(false);
    expect(result.outcome).toBe('would-add');
    expect(result.plan!.addAllow).toContain('mcp__playwright__*');
    expect(result.detail).toContain('authored');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });

  it('apply: writes the additions, keeps every other setting, and a second run has nothing to add', () => {
    const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'ink hooks on-stop' }] }] };
    writeSettings({ permissions: ROOT_COPY, enableAllProjectMcpServers: true, hooks });
    const first = sync(true);
    expect(first.outcome).toBe('added');
    const after = readSettings();
    expect(Object.keys(after)).toEqual(['permissions', 'enableAllProjectMcpServers', 'hooks']);
    expect(after.hooks).toEqual(hooks);
    expect(after.enableAllProjectMcpServers).toBe(true);
    expect(after.permissions.allow).toEqual([...ROOT_COPY.allow, ...first.plan!.addAllow]);
    expect(after.permissions.deny).toEqual(first.plan!.addDeny);
    expect(after.permissions.allow).toContain('mcp__playwright__*');

    const bytes = readFileSync(settingsPath, 'utf-8');
    const second = sync(true);
    expect(second.outcome).toBe('nothing-to-add');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(bytes);
  });

  it('names the scratch paths of the owner it was given', () => {
    writeSettings({ permissions: ROOT_COPY });
    const result = sync(false, 'builder', 'lumen');
    expect(result.plan!.addAllow).toContain('Edit(~/.ink/files/lumen-scratch/**)');
    expect(result.plan!.addAllow.join('\n')).not.toContain('wren-scratch');
  });

  it('adds the reviewer profile for a reviewer', () => {
    writeSettings({ permissions: { allow: ['Bash(*)'], deny: [] } });
    const result = sync(true, 'reviewer');
    expect(result.outcome).toBe('added');
    expect(readSettings().permissions.deny).toEqual(reviewer.deny);
    expect(readSettings().permissions.deny).toContain('Bash(git commit *)');
  });

  it('leaves a file that already holds exactly the profile as it is', () => {
    const before = writeSettings({ permissions: builder, enableAllProjectMcpServers: true });
    const result = sync(true);
    expect(result.outcome).toBe('nothing-to-add');
    expect(result.detail).toContain('generated');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });

  it('leaves a reset studio (an empty permissions object) as it is', () => {
    const before = writeSettings({ permissions: {} });
    const result = sync(true);
    expect(result.outcome).toBe('skipped');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });

  it('creates nothing where there is no file or no permissions object, and names ink init', () => {
    const absent = sync(true);
    expect(absent.outcome).toBe('skipped');
    expect(absent.detail).toContain('ink init');
    expect(existsSync(settingsPath)).toBe(false);

    const before = writeSettings({ hooks: {} });
    const noKey = sync(true);
    expect(noKey.outcome).toBe('skipped');
    expect(noKey.detail).toContain('ink init');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });

  it.each([
    ['not JSON', '{ "permissions": '],
    ['not an object', '[]'],
    ['permissions not an object', JSON.stringify({ permissions: ['Bash(*)'] })],
    ['allow not a list', JSON.stringify({ permissions: { allow: 'Bash(*)' } })],
    ['an allow rule that is not a string', JSON.stringify({ permissions: { allow: [1] } })],
    [
      'a deny rule that is not a string',
      JSON.stringify({ permissions: { allow: ['Read(*)'], deny: [1] } }),
    ],
  ])('refuses a file it cannot read (%s), and leaves it as it is', (_label, text) => {
    writeSettings(text);
    const result = sync(true);
    expect(result.outcome).toBe('refused');
    expect(result.detail).toContain('left as it is');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(text);
  });

  it('names the rule list it cannot read', () => {
    writeSettings(JSON.stringify({ permissions: { allow: [1] } }));
    expect(sync(true).detail).toContain('permissions.allow is not a list of rules');
  });

  it('refuses to write through a symlinked settings file', () => {
    const target = join(root, 'elsewhere.json');
    const text = JSON.stringify({ permissions: ROOT_COPY });
    writeFileSync(target, text);
    mkdirSync(join(root, '.claude'), { recursive: true });
    symlinkSync(target, settingsPath);
    const result = sync(true);
    expect(result.outcome).toBe('refused');
    expect(readFileSync(target, 'utf-8')).toBe(text);
  });

  it('refuses to write through a symlinked .claude directory', () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    const text = JSON.stringify({ permissions: ROOT_COPY });
    writeFileSync(join(elsewhere, 'settings.local.json'), text);
    symlinkSync(elsewhere, join(root, '.claude'));
    const result = sync(true);
    expect(result.outcome).toBe('refused');
    expect(readFileSync(join(elsewhere, 'settings.local.json'), 'utf-8')).toBe(text);
  });
});

// Bash rules name commands in more than one spelling (Lumen, review
// 5399743367 on #733): a sole trailing ` *` also matches the bare command,
// and the legacy `X:*` is the same rule as `X *`.
describe('named Bash allows, in every spelling', () => {
  it.each([
    ['reviewer', 'Bash(git push *)', 'Bash(git push)'],
    ['reviewer', 'Bash(git push *)', 'Bash(git push:*)'],
    ['reviewer', 'Bash(git add *)', 'Bash(git add:*)'],
    ['builder', 'Bash(git push --force *)', 'Bash(git push --force:*)'],
    ['builder', 'Bash(git push --force *)', 'Bash(git push --force)'],
  ] as const)('%s: %s is kept out beside an authored %s', (profile, deny, allow) => {
    const plan = planProfileSync(
      { allow: [allow], deny: [] },
      studioPermissionRules(profile, 'lumen')
    );
    expect(plan.addDeny).not.toContain(deny);
    expect(plan.kept).toContainEqual(
      expect.objectContaining({
        rule: deny,
        list: 'deny',
        reason: `this file allows ${allow} by name`,
      })
    );
  });

  it('a backstop narrower than a prefix grant is still added beside it', () => {
    const plan = planProfileSync({ allow: ['Bash(git push:*)'], deny: [] }, builder);
    expect(plan.addDeny).toContain('Bash(git push *--force*)');
    expect(plan.addDeny).toContain('Bash(git push * main)');
    expect(denyRefusesNamedAllow('Bash(git push *--force*)', 'Bash(git push *)')).toBe(false);
  });

  it('a broad grant names no command, so every backstop goes in beside it', () => {
    expect(planProfileSync({ allow: ['Bash(*)', 'mcp__github__*'] }, builder).addDeny).toEqual(
      builder.deny
    );
    expect(denyRefusesNamedAllow('Bash(git push *)', 'Bash(git *)')).toBe(false);
    expect(denyRefusesNamedAllow('Bash(git push *)', 'Bash(git:*)')).toBe(false);
  });

  it('applies Bash spellings to Bash rules only', () => {
    expect(denyRefusesNamedAllow('Read(/a *)', 'Read(/a)')).toBe(false);
  });

  it('only a trailing :* is the legacy prefix form', () => {
    expect(denyRefusesNamedAllow('Bash(foo *)', 'Bash(foo:*x)')).toBe(false);
    expect(denyRefusesNamedAllow('Bash(foo *)', 'Bash(foo:*)')).toBe(true);
  });

  it('broad grants never keep the force or main backstops out', () => {
    expect(denyRefusesNamedAllow('Bash(git push *--force*)', 'Bash(git *)')).toBe(false);
    expect(denyRefusesNamedAllow('Bash(git push * main)', 'Bash(git:*)')).toBe(false);
    expect(denyRefusesNamedAllow('Bash(git push -f *)', 'Bash(*)')).toBe(false);
  });

  it('only a sole trailing wildcard names the bare command', () => {
    expect(denyRefusesNamedAllow('Bash(git -C * push)', 'Bash(git -C * push *)')).toBe(false);
    expect(denyRefusesNamedAllow('Bash(git push)', 'Bash(git push *)')).toBe(true);
  });
});

describe('retired denies (spec automated-turn-permissions §3.4)', () => {
  const builderRules = studioPermissionRules('builder', 'wren');

  it('removes exactly the retired denies, keeping every other deny in place', () => {
    const plan = planProfileSync(
      {
        allow: ['Bash(*)'],
        deny: ['Bash(rm -rf *)', 'Bash(sudo *)', 'Bash(git reset --hard *)', 'Bash(rm -rf /tmp/x)'],
      },
      builderRules
    );
    expect(plan.removeDeny).toEqual(['Bash(rm -rf *)', 'Bash(git reset --hard *)']);
    const deny = (plan.permissions as { deny: string[] }).deny;
    expect(deny).not.toContain('Bash(rm -rf *)');
    expect(deny.slice(0, 2)).toEqual(['Bash(sudo *)', 'Bash(rm -rf /tmp/x)']);
  });

  it('a file carrying only retired denies and the rest of the profile is not left as it is', () => {
    const old = {
      allow: [...builderRules.allow],
      deny: ['Bash(rm -rf *)', ...builderRules.deny],
    };
    const plan = planProfileSync(old, builderRules);
    expect(plan.state).toBe('authored');
    expect(plan.removeDeny).toEqual(['Bash(rm -rf *)']);
    expect(plan.permissions).toEqual(builderRules);
  });

  it("lifts a builder's old PR and SQL denies, and keeps a reviewer's", () => {
    const lifted = [
      'mcp__github__create_pull_request',
      'mcp__github__update_pull_request',
      'mcp__github__update_pull_request_branch',
      'mcp__supabase__execute_sql',
    ];
    const file = { allow: ['Bash(*)'], deny: ['Bash(sudo *)', ...lifted] };

    const built = planProfileSync(file, builderRules);
    expect(built.removeDeny).toEqual(lifted);
    expect((built.permissions as { deny: string[] }).deny).not.toEqual(
      expect.arrayContaining(['mcp__supabase__execute_sql'])
    );

    const reviewed = planProfileSync(file, studioPermissionRules('reviewer', 'wren'));
    expect(reviewed.removeDeny).toEqual([]);
    expect((reviewed.permissions as { deny: string[] }).deny).toEqual(
      expect.arrayContaining(lifted)
    );
  });

  describe('one sync brings the old generated builder profile up to date', () => {
    const lifted = [
      'mcp__github__create_pull_request',
      'mcp__github__update_pull_request',
      'mcp__github__update_pull_request_branch',
      'mcp__supabase__execute_sql',
    ];
    const installs = ['Bash(yarn)', 'Bash(yarn install*)', 'Bash(npm install*)'];
    // What the builder profile generated before this branch: the PR and SQL
    // tools denied rather than allowed, and installs denied.
    const old = {
      allow: builderRules.allow.filter((rule) => !lifted.includes(rule)),
      deny: [...builderRules.deny, ...lifted, ...installs],
    };

    it('grants the PR and SQL tools in the pass that lifts their denies', () => {
      const plan = planProfileSync(old, builderRules);
      const permissions = plan.permissions as { allow: string[]; deny: string[] };
      expect(plan.addAllow).toEqual(lifted);
      expect(plan.removeDeny).toEqual([...lifted, ...installs]);
      expect(plan.kept).toEqual([]);
      expect([...permissions.allow].sort()).toEqual([...builderRules.allow].sort());
      expect([...permissions.deny].sort()).toEqual([...builderRules.deny].sort());
    });

    it('leaves nothing for a second sync to do', () => {
      const once = planProfileSync(old, builderRules);
      const twice = planProfileSync(once.permissions, builderRules);
      expect(twice.addAllow).toEqual([]);
      expect(twice.addDeny).toEqual([]);
      expect(twice.removeDeny).toEqual([]);
    });

    it('still keeps out an allow the file asks about', () => {
      const plan = planProfileSync({ ...old, ask: ['mcp__supabase__execute_sql'] }, builderRules);
      const permissions = plan.permissions as { allow: string[]; ask: string[] };
      expect(permissions.allow).not.toContain('mcp__supabase__execute_sql');
      expect(permissions.ask).toEqual(['mcp__supabase__execute_sql']);
      expect(plan.kept).toContainEqual(
        expect.objectContaining({ rule: 'mcp__supabase__execute_sql', list: 'allow' })
      );
    });
  });

  it("lifts a builder's old merge denies, and keeps a reviewer's", () => {
    const merge = ['mcp__github__merge_pull_request', 'Bash(gh pr merge*)', 'Bash(gh * pr merge*)'];
    const file = { allow: ['Bash(*)'], deny: ['Bash(sudo *)', ...merge] };
    const built = planProfileSync(file, builderRules);
    expect(built.removeDeny).toEqual(merge);
    expect(built.addAllow).toContain('mcp__github__merge_pull_request');
    const reviewed = planProfileSync(file, studioPermissionRules('reviewer', 'wren'));
    expect(reviewed.removeDeny).toEqual([]);
    expect((reviewed.permissions as { deny: string[] }).deny).toEqual(
      expect.arrayContaining(merge)
    );
  });

  it('lifts the old install denies from a builder and a reviewer alike', () => {
    const installs = ['Bash(yarn)', 'Bash(yarn install*)', 'Bash(npm ci*)', 'Bash(pnpm add *)'];
    const file = { allow: ['Bash(*)'], deny: ['Bash(sudo *)', ...installs] };
    for (const profile of ['builder', 'reviewer'] as const) {
      const plan = planProfileSync(file, studioPermissionRules(profile, 'wren'));
      expect(plan.removeDeny, profile).toEqual(installs);
      expect((plan.permissions as { deny: string[] }).deny, profile).toContain('Bash(sudo *)');
    }
  });
});
