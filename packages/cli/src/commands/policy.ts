import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { TOOL_GROUPS } from '../repl/tool-policy.js';
import { TOOL_PROFILES, type ToolProfileId } from '../repl/tool-profiles.js';

const DEFAULT_POLICY_PATH = join(homedir(), '.ink', 'security', 'tool-policy.json');

interface PolicyFileV2 {
  version: 2;
  scopes: {
    global?: ScopeRules;
    workspace?: Record<string, ScopeRules>;
    agent?: Record<string, ScopeRules>;
    studio?: Record<string, ScopeRules>;
  };
}

interface ScopeRules {
  mode?: string;
  allowTools?: string[];
  denyTools?: string[];
  promptTools?: string[];
  grants?: Record<string, number>;
  skillTrustMode?: string;
  sessionVisibility?: string;
}

function readPolicyFile(): PolicyFileV2 | null {
  const path = process.env.INK_TOOL_POLICY_PATH || DEFAULT_POLICY_PATH;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function expandGroup(spec: string): string[] {
  const group = TOOL_GROUPS[spec as keyof typeof TOOL_GROUPS];
  return group ? group : [spec];
}

function formatToolList(tools: string[], color: (s: string) => string): string {
  if (tools.length === 0) return chalk.dim('  (none)');
  return tools.map((t) => `  ${color('●')} ${t}`).join('\n');
}

export function registerPolicyCommands(parent: Command): void {
  const policy = parent.command('policy').description('View and manage tool policy configuration');

  policy
    .command('show')
    .description('Display current policy state from disk')
    .option('--path <path>', 'Policy file path (default: ~/.ink/security/tool-policy.json)')
    .action((options: { path?: string }) => {
      if (options.path) process.env.INK_TOOL_POLICY_PATH = options.path;

      const data = readPolicyFile();
      if (!data) {
        console.log(chalk.dim('No policy file found at:'));
        console.log(chalk.dim(`  ${process.env.INK_TOOL_POLICY_PATH || DEFAULT_POLICY_PATH}`));
        console.log();
        console.log('Policy defaults apply. Use /profile in an ink chat session to configure.');
        return;
      }

      console.log(chalk.bold('Tool Policy') + chalk.dim(` (v${data.version})`));
      console.log();

      const scopes = data.scopes || {};

      for (const [scopeType, scopeData] of Object.entries(scopes)) {
        if (scopeType === 'global') {
          printScope('Global', scopeData as ScopeRules);
        } else if (typeof scopeData === 'object' && scopeData !== null) {
          for (const [id, rules] of Object.entries(scopeData as Record<string, ScopeRules>)) {
            printScope(`${scopeType}:${id}`, rules);
          }
        }
      }
    });

  policy
    .command('profiles')
    .description('List available security profiles')
    .action(() => {
      console.log(chalk.bold('Security Profiles'));
      console.log();

      for (const [id, profile] of Object.entries(TOOL_PROFILES)) {
        const isDefaultSafe = id === 'safe';
        console.log(
          `  ${chalk.bold(profile.label)}${isDefaultSafe ? chalk.blue(' (recommended)') : ''}`
        );
        console.log(`  ${chalk.dim(profile.description)}`);
        console.log(`  Mode: ${formatMode(profile.mode)}`);

        const allowTools = profile.allowSpecs.flatMap(expandGroup);
        const promptTools = profile.promptSpecs.flatMap(expandGroup);
        const denyTools = profile.denySpecs.flatMap(expandGroup);

        if (allowTools.length > 0) {
          console.log(`  ${chalk.green('Allow')}: ${allowTools.join(', ')}`);
        }
        if (promptTools.length > 0) {
          console.log(`  ${chalk.yellow('Prompt')}: ${promptTools.join(', ')}`);
        }
        if (denyTools.length > 0) {
          console.log(`  ${chalk.red('Deny')}: ${denyTools.join(', ')}`);
        }
        console.log();
      }

      console.log(chalk.dim('Apply with: /profile <name> inside an ink chat session'));
    });

  policy
    .command('groups')
    .description('List tool groups and their members')
    .action(() => {
      console.log(chalk.bold('Tool Groups'));
      console.log();

      for (const [groupId, tools] of Object.entries(TOOL_GROUPS)) {
        const label = groupId.replace('group:', '');
        console.log(`  ${chalk.bold(label)} ${chalk.dim(`(${groupId})`)}`);
        console.log(`  ${tools.join(', ')}`);
        console.log();
      }
    });

  policy
    .command('matrix')
    .description('Show profile × group permission matrix')
    .action(() => {
      const groupIds = Object.keys(TOOL_GROUPS).filter((g) => g !== 'group:ink-safe');
      const profileIds = Object.keys(TOOL_PROFILES) as ToolProfileId[];

      // Header
      const groupLabels = groupIds.map((g) => g.replace('group:', ''));
      const colWidth = 14;
      const labelWidth = 14;

      console.log(chalk.bold('Permission Matrix'));
      console.log();

      // Column headers
      const header = ''.padEnd(labelWidth) + groupLabels.map((l) => l.padEnd(colWidth)).join('');
      console.log(chalk.dim(header));
      console.log(chalk.dim('─'.repeat(labelWidth + groupLabels.length * colWidth)));

      for (const profileId of profileIds) {
        const profile = TOOL_PROFILES[profileId];
        const cells = groupIds.map((groupId) => {
          if (profile.denySpecs.includes(groupId)) return chalk.red('denied'.padEnd(colWidth));
          if (profile.promptSpecs.includes(groupId))
            return chalk.yellow('approval'.padEnd(colWidth));
          if (profile.allowSpecs.includes(groupId)) return chalk.green('allowed'.padEnd(colWidth));
          return chalk.dim('default'.padEnd(colWidth));
        });

        console.log(chalk.bold(profile.label.padEnd(labelWidth)) + cells.join(''));
      }

      console.log();
      console.log(chalk.dim('default = allowed (no explicit rule, falls through to allow)'));
    });

  // Default to show
  policy.action(() => {
    policy.commands.find((c) => c.name() === 'show')?.parse(process.argv);
  });
}

function formatMode(mode: string): string {
  switch (mode) {
    case 'privileged':
      return chalk.yellow('privileged');
    case 'off':
      return chalk.red('off');
    case 'backend':
    default:
      return chalk.green('backend');
  }
}

function printScope(label: string, rules: ScopeRules): void {
  console.log(chalk.bold.underline(label));

  if (rules.mode) {
    console.log(`  Mode: ${formatMode(rules.mode)}`);
  }

  if (rules.allowTools && rules.allowTools.length > 0) {
    console.log(`  ${chalk.green('Allow')}:`);
    console.log(formatToolList(rules.allowTools, chalk.green));
  }

  if (rules.promptTools && rules.promptTools.length > 0) {
    console.log(`  ${chalk.yellow('Prompt')}:`);
    console.log(formatToolList(rules.promptTools, chalk.yellow));
  }

  if (rules.denyTools && rules.denyTools.length > 0) {
    console.log(`  ${chalk.red('Deny')}:`);
    console.log(formatToolList(rules.denyTools, chalk.red));
  }

  if (rules.grants && Object.keys(rules.grants).length > 0) {
    console.log(`  ${chalk.cyan('Grants')}:`);
    for (const [tool, uses] of Object.entries(rules.grants)) {
      console.log(`  ${chalk.cyan('●')} ${tool} (${uses} uses)`);
    }
  }

  if (rules.skillTrustMode) {
    console.log(`  Skill trust: ${rules.skillTrustMode}`);
  }
  if (rules.sessionVisibility) {
    console.log(`  Session visibility: ${rules.sessionVisibility}`);
  }

  console.log();
}
