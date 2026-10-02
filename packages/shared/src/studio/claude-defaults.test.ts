/**
 * The studio permission profiles (design v3, push per v4).
 *
 * Two kinds of check. The lists themselves: GitHub and Supabase tools named
 * one by one, no server-wide wildcard for either, the SB's scratch paths
 * expanded, every Bash deny a backstop. And their COMPOSITION, through a
 * fixture evaluator that models Claude Code's documented matching (a `*` in
 * a Bash rule spans spaces; a trailing ` *` also matches the bare command
 * when it is the rule's only wildcard; an `mcp__<server>__*` allow matches
 * that server's tools; deny beats allow, and anything unmatched asks). A
 * rule that is present can still be inert or shadowed, so presence is not
 * what is pinned: what the evaluator decides for a call is. The evaluator
 * is a model, not Claude Code; it proves the lists are written as
 * specified, not that an action is impossible.
 *
 * Imported as a namespace so that, against a tree without these exports,
 * each test fails on its own rather than the file failing to load.
 */
import { describe, it, expect } from 'vitest';
import * as defaults from './claude-defaults.js';

type Decision = 'allow' | 'deny' | 'ask';
type Call = { tool: 'Bash'; command: string } | { tool: string };

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

function bashRuleMatches(pattern: string, command: string): boolean {
  const glob = new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`, 's');
  if (glob.test(command)) return true;
  // "A * at the end, with a space before it, also matches the bare command,"
  // only when that trailing * is the rule's only wildcard.
  const wildcards = pattern.split('*').length - 1;
  return wildcards === 1 && pattern.endsWith(' *') && command === pattern.slice(0, -2);
}

function ruleMatches(rule: string, call: Call): boolean {
  const scoped = rule.match(/^([A-Za-z]+)\((.*)\)$/s);
  if (scoped) {
    const [, tool, pattern] = scoped;
    return tool === 'Bash' && call.tool === 'Bash' && 'command' in call
      ? bashRuleMatches(pattern, call.command)
      : false;
  }
  if (rule.startsWith('mcp__') && rule.endsWith('*'))
    return call.tool.startsWith(rule.slice(0, -1));
  return rule === call.tool;
}

function decide(
  rules: { allow: readonly string[]; deny: readonly string[] },
  call: Call
): Decision {
  if (rules.deny.some((r) => ruleMatches(r, call))) return 'deny';
  if (rules.allow.some((r) => ruleMatches(r, call))) return 'allow';
  return 'ask';
}

const bash = (command: string): Call => ({ tool: 'Bash', command });
const builder = () => defaults.studioPermissionRules('builder', 'wren');
const reviewer = () => defaults.studioPermissionRules('reviewer', 'wren');

describe('the evaluator models the documented matching (its own controls)', () => {
  it('a trailing " *" matches the bare command; "*" spans spaces; deny beats allow', () => {
    const rules = { allow: ['Bash(*)'], deny: ['Bash(git log *)', 'Bash(git * main)'] };
    expect(decide(rules, bash('git log'))).toBe('deny');
    expect(decide(rules, bash('git log --oneline'))).toBe('deny');
    expect(decide(rules, bash('git push origin main'))).toBe('deny');
    expect(decide(rules, bash('git status'))).toBe('allow');
    expect(decide({ allow: [], deny: [] }, bash('ls'))).toBe('ask');
    expect(decide({ allow: ['mcp__github__*'], deny: [] }, { tool: 'mcp__github__get_me' })).toBe(
      'allow'
    );
  });
});

describe('the builder profile — composition', () => {
  const ownBranch = 'wren/feat/studio-builder-permissions';

  it('pushes its own feature branch: plain, with -u, bare, and by refspec', () => {
    for (const command of [
      `git push origin ${ownBranch}`,
      `git push -u origin ${ownBranch}`,
      `git push --set-upstream origin ${ownBranch}`,
      `git push origin HEAD:${ownBranch}`,
      'git push',
    ]) {
      expect(decide(builder(), bash(command)), command).toBe('allow');
    }
  });

  it('a branch whose name contains "-f" or "main" is not caught by the force or main denies', () => {
    for (const command of [
      'git push origin wren/fix-flaky',
      'git push origin wren/feat/main-menu',
      'git push -u origin lumen/feat/domain',
    ]) {
      expect(decide(builder(), bash(command)), command).toBe('allow');
    }
  });

  it('denies force in every position: --force, --force-with-lease, -f, a + refspec', () => {
    for (const command of [
      `git push --force origin ${ownBranch}`,
      `git push origin ${ownBranch} --force`,
      `git push --force-with-lease origin ${ownBranch}`,
      `git push origin ${ownBranch} --force-with-lease=${ownBranch}`,
      `git push -f origin ${ownBranch}`,
      `git push origin ${ownBranch} -f`,
      `git push origin +${ownBranch}`,
      `git push origin +HEAD:${ownBranch}`,
      `git -C . push --force origin ${ownBranch}`,
    ]) {
      expect(decide(builder(), bash(command)), command).toBe('deny');
    }
  });

  it('denies main as the destination: main, HEAD:main, :main, refs/heads/main', () => {
    for (const command of [
      'git push origin main',
      'git push -u origin main',
      'git push origin main --tags',
      'git push origin HEAD:main',
      `git push origin ${ownBranch}:main`,
      'git push origin :main',
      'git push origin HEAD:refs/heads/main',
      'git -C . push origin HEAD:main',
    ]) {
      expect(decide(builder(), bash(command)), command).toBe('deny');
    }
  });

  it('denies --no-verify, which would skip the pre-push scan', () => {
    for (const command of [
      `git push --no-verify origin ${ownBranch}`,
      `git push origin ${ownBranch} --no-verify`,
      `git -C . push --no-verify origin ${ownBranch}`,
    ]) {
      expect(decide(builder(), bash(command)), command).toBe('deny');
    }
  });

  it('denies the GitHub tools that open, merge, close or retarget a PR or write a branch or file', () => {
    for (const tool of [
      'mcp__github__create_pull_request',
      'mcp__github__merge_pull_request',
      'mcp__github__update_pull_request',
      'mcp__github__update_pull_request_branch',
      'mcp__github__push_files',
      'mcp__github__create_or_update_file',
      'mcp__github__delete_file',
      'mcp__github__create_branch',
    ]) {
      expect(decide(builder(), { tool }), tool).toBe('deny');
    }
  });

  it('commits locally, and asks before a GitHub tool it neither allows nor denies', () => {
    expect(decide(builder(), bash('git add packages/shared/src/x.ts'))).toBe('allow');
    expect(decide(builder(), bash('git commit -F /tmp/msg'))).toBe('allow');
    expect(decide(builder(), { tool: 'mcp__github__add_issue_comment' })).toBe('ask');
  });

  it('reads GitHub and Supabase, and is denied the database writes', () => {
    expect(decide(builder(), { tool: 'mcp__github__pull_request_read' })).toBe('allow');
    expect(decide(builder(), { tool: 'mcp__supabase__list_tables' })).toBe('allow');
    expect(decide(builder(), { tool: 'mcp__supabase__execute_sql' })).toBe('deny');
    expect(decide(builder(), { tool: 'mcp__supabase__apply_migration' })).toBe('deny');
  });

  it('denies installs, bare yarn included, and keeps the destructive defaults', () => {
    for (const command of [
      'yarn',
      'yarn install',
      'yarn install --immutable',
      'yarn add left-pad',
      'npm install',
      'npm ci',
      'pnpm add x',
      'pnpm install',
      'rm -rf build',
      'git reset --hard HEAD~1',
    ]) {
      expect(decide(builder(), bash(command)), command).toBe('deny');
    }
    expect(decide(builder(), bash('yarn workspace @inklabs/shared build'))).toBe('allow');
  });

  it('a spelling the rules do not name gets through: these are backstops, and the test says so', () => {
    // Pinned so a reader of the profile sees the limit measured, not implied.
    expect(decide(builder(), bash(`git -c push.default=current push --force`))).toBe('allow');
    expect(decide(builder(), bash(`git push -uf origin ${ownBranch}`))).toBe('allow');
    // And branch ownership is not a rule at all: a deny cannot say "any
    // branch but this one", so another SB's branch is allowed by the lists.
    expect(decide(builder(), bash('git push origin lumen/feat/other'))).toBe('allow');
  });
});

describe('the reviewer profile — composition', () => {
  it('denies every push, staging and committing, in each spelling the rules name', () => {
    for (const command of [
      'git push',
      'git push origin wren/feat/x',
      'git -C . push origin wren/feat/x',
      'git --git-dir=.git push origin x',
      'git add .',
      'git add',
      'git commit -m x',
      'git commit',
      'git -C . commit -m x',
      'yarn install',
    ]) {
      expect(decide(reviewer(), bash(command)), command).toBe('deny');
    }
  });

  it('posts its review to GitHub, and every other GitHub and Supabase write is denied', () => {
    for (const tool of defaults.GITHUB_REVIEW_TOOLS) {
      expect(decide(reviewer(), { tool }), tool).toBe('allow');
    }
    for (const tool of [
      ...defaults.GITHUB_PUBLISH_TOOLS,
      ...defaults.GITHUB_OTHER_WRITE_TOOLS,
      ...defaults.SUPABASE_WRITE_TOOLS,
    ]) {
      expect(decide(reviewer(), { tool }), tool).toBe('deny');
    }
  });

  it('runs tests, and edits only the scratch directories (Bash is the backstop caveat)', () => {
    expect(decide(reviewer(), bash('npx vitest run'))).toBe('allow');
    expect(reviewer().allow).not.toContain('Edit(/**)');
    expect(reviewer().allow).not.toContain('Write(/**)');
    expect(reviewer().allow).toContain('Edit(~/.ink/files/wren-scratch/**)');
  });
});

describe('the profile lists', () => {
  it('neither profile approves a GitHub or Supabase server wildcard', () => {
    for (const rules of [builder(), reviewer()]) {
      expect(rules.allow).not.toContain('mcp__github__*');
      expect(rules.allow).not.toContain('mcp__supabase__*');
      for (const rule of rules.allow) {
        expect(
          rule.startsWith('mcp__github__') || rule.startsWith('mcp__supabase__') ? rule : ''
        ).not.toMatch(/\*/);
      }
    }
  });

  it('the read lists are reads and the write lists are writes: no tool is in both', () => {
    const reads = new Set([...defaults.GITHUB_READ_TOOLS, ...defaults.SUPABASE_READ_TOOLS]);
    for (const tool of [
      ...defaults.GITHUB_PUBLISH_TOOLS,
      ...defaults.GITHUB_REVIEW_TOOLS,
      ...defaults.GITHUB_OTHER_WRITE_TOOLS,
      ...defaults.SUPABASE_WRITE_TOOLS,
    ]) {
      expect(reads.has(tool), tool).toBe(false);
    }
    for (const tool of reads) {
      expect(tool, tool).toMatch(
        /^mcp__(github|supabase)__(get_|list_|search_|issue_read$|pull_request_read$|generate_typescript_types$)/
      );
    }
  });

  it('the builder edits its own checkout and its SB scratch paths, expanded for that SB', () => {
    const rules = defaults.studioPermissionRules('builder', 'lumen');
    expect(rules.allow).toEqual(
      expect.arrayContaining([
        'Read(*)',
        'Edit(/**)',
        'Write(/**)',
        'Bash(*)',
        'WebFetch(*)',
        'WebSearch',
        'mcp__inkwell__*',
        'mcp__playwright__*',
        'Edit(~/.ink/files/lumen-scratch/**)',
        'Write(~/.ink/files/lumen-scratch/**)',
        'Edit(~/.ink/files/lumen-screenshots/**)',
        'Write(~/.ink/files/lumen-screenshots/**)',
      ])
    );
    expect(rules.allow.join('\n')).not.toContain('wren-');
    // The old full-auto checkout-relative rules are not the builder's.
    expect(rules.allow).not.toContain('Edit(*)');
  });

  it('the builder carries no blanket push deny: deny beats allow, so one would forbid every push', () => {
    for (const rule of defaults.PUSH_DENY_RULES) {
      expect(builder().deny, rule).not.toContain(rule);
    }
    expect(defaults.STUDIO_PUSH_RULES.allow).toContain('Bash(git push *)');
  });

  it('no rule is listed twice, and no rule is both allowed and denied', () => {
    for (const rules of [builder(), reviewer()]) {
      expect(new Set(rules.allow).size).toBe(rules.allow.length);
      expect(new Set(rules.deny).size).toBe(rules.deny.length);
      expect(rules.allow.filter((r) => rules.deny.includes(r))).toEqual([]);
    }
  });

  it('the Bash denies are labelled backstops in the source', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(
      fileURLToPath(new URL('./claude-defaults.ts', import.meta.url)),
      'utf-8'
    );
    expect(source).toMatch(/POLICY BACKSTOP, not enforced isolation/);
  });
});

describe('studioPermissionProfile reads the server record only', () => {
  it('a detached checkout, by branch sentinel or by checkout pin, is a reviewer', () => {
    expect(defaults.studioPermissionProfile({ branch: 'detached:origin/pr/7' })).toBe('reviewer');
    expect(defaults.studioPermissionProfile({ branch: 'detached:main' })).toBe('reviewer');
    expect(
      defaults.studioPermissionProfile({
        branch: 'lumen/eph/pr-7',
        metadata: { checkout: { mode: 'detached', ref: 'origin/pr/7', commit: 'abc' } },
      })
    ).toBe('reviewer');
  });

  it('a studio on a branch of its own, or no record, is a builder', () => {
    expect(defaults.studioPermissionProfile({ branch: 'wren/feat/x', metadata: {} })).toBe(
      'builder'
    );
    expect(defaults.studioPermissionProfile({ branch: 'wren/feat/x', metadata: null })).toBe(
      'builder'
    );
    expect(defaults.studioPermissionProfile(null)).toBe('builder');
    expect(defaults.studioPermissionProfile(undefined)).toBe('builder');
  });
});

describe('describePermissions', () => {
  it('names each authored shape, empty and mode-only included', () => {
    expect(defaults.describePermissions({})).toBe('empty permissions object');
    expect(defaults.describePermissions({ defaultMode: 'plan' })).toBe('defaultMode plan');
    expect(defaults.describePermissions({ deny: ['Bash(x)'], ask: ['Bash(y)', 'Bash(z)'] })).toBe(
      '1 deny, 2 ask'
    );
  });
});
