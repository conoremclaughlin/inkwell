/**
 * The studio checklist (task c3b34be8).
 *
 * What a worktree must carry before a session in it has its tools, its
 * identity and its hooks. On 2026-09-24 a census of the inktrade worktrees
 * found no creator producing the full set: a server-created studio had
 * `.mcp.json` and Claude hooks but no identity file and no Codex or Gemini
 * hooks; a CLI-created one had identity and hooks but no `.env.local` and
 * no permissions; a bare `git worktree add` had nothing. A partial studio is
 * invisible until a session inside it finds it has no tools, and without
 * `.ink/identity.json` the hooks book its work to the root studio ("main").
 *
 * ONE list, three readers. `ink init` decides what to write from it,
 * `ink doctor` prints it, and the server runs it before every Claude spawn
 * and completes the studio when something is missing. Pure filesystem: the
 * server-side registration of the studio row is `ink doctor`'s own check,
 * because it needs the server.
 *
 * Every item is judged on the file that actually carries it, not on the
 * directory existing or the file being non-empty: a `.mcp.json` without the
 * inkwell server is as useless as none, and a settings file whose hooks omit
 * on-stop leaves every lease it holds without a boundary.
 */

import { existsSync, lstatSync, readFileSync } from 'fs';
import { join } from 'path';
import { readCodexConfig } from './mcp-config-sync.js';

export const STUDIO_CHECK_IDS = [
  'mcp-json',
  'env-local',
  'identity',
  'studio-id',
  'claude-permissions',
  'claude-hooks',
  'codex-mcp',
  'codex-hooks',
  'gemini-mcp',
  'gemini-hooks',
] as const;

export type StudioCheckId = (typeof STUDIO_CHECK_IDS)[number];

export interface StudioCheck {
  id: StudioCheckId;
  /** What the item is, for a human. */
  label: string;
  ok: boolean;
  /** Counts toward `complete`. Reported-only items (see env-local) do not. */
  required: boolean;
  /** What was found, one line. */
  detail: string;
  /** The command that repairs it. */
  repair: string;
}

export interface StudioAudit {
  worktreePath: string;
  /** A linked worktree (a studio) rather than the main worktree. */
  linked: boolean;
  checks: StudioCheck[];
  /** Required checks that failed, in checklist order. */
  missing: StudioCheckId[];
  complete: boolean;
}

/** The Claude Code hooks a studio must carry: every lifecycle event ink listens on. */
export const CLAUDE_HOOK_NAMES = [
  'pre-compact',
  'post-compact',
  'on-session-start',
  'on-tool-approval',
  'on-prompt',
  'on-stop',
] as const;

/** The Codex and Gemini hooks: those backends expose fewer events. */
export const CODEX_HOOK_NAMES = ['on-session-start', 'on-prompt', 'on-stop'] as const;
export const GEMINI_HOOK_NAMES = ['on-session-start', 'on-prompt', 'on-stop'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPAIR = 'ink init';

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Any entry at the path — a file, a directory, or a link, dangling or not. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every `command` string inside a hooks object, whatever its nesting. */
function hookCommands(hooks: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (typeof record.command === 'string') out.push(record.command);
    for (const value of Object.values(record)) walk(value);
  };
  walk(hooks);
  return out;
}

/** Which of the wanted ink hooks have no command line naming them. */
function missingHooks(commands: string[], wanted: readonly string[]): string[] {
  return wanted.filter((name) => !commands.some((c) => c.includes(` hooks ${name}`)));
}

function hasInkwellServer(config: Record<string, unknown> | null): boolean {
  const servers = config?.mcpServers;
  return !!servers && typeof servers === 'object' && 'inkwell' in (servers as object);
}

export function auditStudio(worktreePath: string, options: { linked: boolean }): StudioAudit {
  const { linked } = options;
  const checks: StudioCheck[] = [];
  const add = (
    id: StudioCheckId,
    label: string,
    required: boolean,
    ok: boolean,
    detail: string,
    repair = REPAIR
  ) => checks.push({ id, label, ok, required, detail, repair });

  // .mcp.json — the MCP servers a session gets; the inkwell entry is the one
  // that makes it an Inkwell session at all.
  const mcp = readJson(join(worktreePath, '.mcp.json'));
  add(
    'mcp-json',
    '.mcp.json with the inkwell server',
    true,
    hasInkwellServer(mcp),
    existsSync(join(worktreePath, '.mcp.json'))
      ? hasInkwellServer(mcp)
        ? 'inkwell server configured'
        : mcp
          ? 'no inkwell server entry'
          : 'unparseable'
      : 'missing'
  );

  // .env.local — reported, never required: a repo may have none, and a
  // studio whose main worktree has none should not read as broken.
  const envPresent = present(join(worktreePath, '.env.local'));
  add(
    'env-local',
    '.env.local (copied from the main worktree)',
    false,
    envPresent,
    envPresent ? 'present' : 'missing (copied by ink init when the main worktree has one)'
  );

  // .ink/identity.json — who works here. Pre-rename files carry agentId.
  const identity = readJson(join(worktreePath, '.ink', 'identity.json'));
  const slug =
    typeof identity?.sbSlug === 'string'
      ? identity.sbSlug
      : typeof identity?.agentId === 'string'
        ? identity.agentId
        : null;
  // Required in a linked worktree: without it the hooks book every session
  // to the root studio. The main worktree's hooks fall back to the
  // sbMapping in ~/.ink/config.json, so there it is reported, not required.
  add(
    'identity',
    '.ink/identity.json naming the SB',
    linked,
    !!slug || !linked,
    slug
      ? `sbSlug ${slug}`
      : identity
        ? 'no sbSlug'
        : existsSync(join(worktreePath, '.ink', 'identity.json'))
          ? 'unparseable'
          : linked
            ? 'missing'
            : 'missing (the main worktree resolves identity from ~/.ink/config.json)'
  );

  // studioId — a linked worktree must know its own studio row, or its hooks
  // book every session to "main" and nothing auto-registers.
  const studioId = typeof identity?.studioId === 'string' ? identity.studioId : '';
  const hasStudioId = UUID.test(studioId);
  add(
    'studio-id',
    'identity.json carries the studio id',
    linked,
    hasStudioId || !linked,
    hasStudioId
      ? `studioId ${studioId}`
      : linked
        ? studioId
          ? `studioId "${studioId}" is not a studio row`
          : 'no studioId: sessions here would be booked to the root studio'
        : 'main worktree: not needed'
  );

  // .claude/settings.local.json — permissions and hooks live in one file,
  // and are two different items: a file with hooks and no allow list makes
  // every tool call ask.
  const settingsPath = join(worktreePath, '.claude', 'settings.local.json');
  const settings = readJson(settingsPath);
  const permissions =
    settings?.permissions && typeof settings.permissions === 'object'
      ? (settings.permissions as Record<string, unknown>)
      : null;
  const allow = Array.isArray(permissions?.allow) ? (permissions?.allow as unknown[]) : [];
  add(
    'claude-permissions',
    '.claude/settings.local.json permissions',
    linked,
    allow.length > 0 || !linked,
    allow.length > 0
      ? `${allow.length} allow rule(s)`
      : linked
        ? settings
          ? 'no allow rules'
          : existsSync(settingsPath)
            ? 'unparseable'
            : 'missing'
        : 'main worktree: not defaulted'
  );
  const claudeMissing = missingHooks(hookCommands(settings?.hooks), CLAUDE_HOOK_NAMES);
  add(
    'claude-hooks',
    '.claude/settings.local.json ink hooks',
    true,
    claudeMissing.length === 0,
    claudeMissing.length === 0
      ? `all ${CLAUDE_HOOK_NAMES.length} hooks`
      : settings
        ? `missing ${claudeMissing.join(', ')}`
        : existsSync(settingsPath)
          ? 'unparseable'
          : 'missing'
  );

  // .codex/config.toml — the MCP section `ink mcp sync` writes and the
  // hooks table `ink hooks install --backend codex` writes.
  // Read by what its keys resolve to, not by how a header is spelled: a
  // table defined twice in any spelling is a parse error, and Codex refuses
  // to start at all (lumen-alpha, 2026-09-29, #701).
  const codex = readText(join(worktreePath, '.codex', 'config.toml'));
  const codexReading = codex === null ? undefined : readCodexConfig(codex);
  add(
    'codex-mcp',
    '.codex/config.toml inkwell MCP section',
    true,
    !!codexReading &&
      codexReading.unreadableLine === undefined &&
      codexReading.redefined.length === 0 &&
      codexReading.definesInkwell &&
      !codexReading.inkwellOutsideBlock,
    !codexReading
      ? 'missing'
      : codexReading.unreadableLine !== undefined
        ? `could not be read at line ${codexReading.unreadableLine}`
        : codexReading.redefined.length > 0
          ? `defines [${codexReading.redefined.join('], [')}] more than once, which Codex cannot parse; run \`ink mcp sync\``
          : !codexReading.definesInkwell
            ? 'no [mcp_servers.inkwell]'
            : codexReading.inkwellOutsideBlock
              ? "defines [mcp_servers.inkwell] outside ink's managed block, where `ink mcp sync` cannot update it; remove that definition, then run `ink mcp sync`"
              : 'inkwell server configured'
  );
  const codexCommands = codex
    ? codex
        .split('\n')
        .map((line) => line.match(/^\s*[a-z_]+\s*=\s*"(.*)"\s*$/)?.[1])
        .filter((v): v is string => typeof v === 'string')
    : [];
  const codexMissing = missingHooks(codexCommands, CODEX_HOOK_NAMES);
  add(
    'codex-hooks',
    '.codex/config.toml ink hooks',
    true,
    codexMissing.length === 0,
    codexMissing.length === 0
      ? `all ${CODEX_HOOK_NAMES.length} hooks`
      : codex
        ? `missing ${codexMissing.join(', ')}`
        : 'missing'
  );

  // .gemini/settings.json — MCP section and hooks, as for Codex.
  const geminiPath = join(worktreePath, '.gemini', 'settings.json');
  const gemini = readJson(geminiPath);
  add(
    'gemini-mcp',
    '.gemini/settings.json inkwell MCP section',
    true,
    hasInkwellServer(gemini),
    hasInkwellServer(gemini)
      ? 'inkwell server configured'
      : gemini
        ? 'no inkwell server entry'
        : existsSync(geminiPath)
          ? 'unparseable'
          : 'missing'
  );
  const geminiMissing = missingHooks(hookCommands(gemini?.hooks), GEMINI_HOOK_NAMES);
  add(
    'gemini-hooks',
    '.gemini/settings.json ink hooks',
    true,
    geminiMissing.length === 0,
    geminiMissing.length === 0
      ? `all ${GEMINI_HOOK_NAMES.length} hooks`
      : gemini
        ? `missing ${geminiMissing.join(', ')}`
        : existsSync(geminiPath)
          ? 'unparseable'
          : 'missing'
  );

  const missing = checks.filter((c) => c.required && !c.ok).map((c) => c.id);
  return { worktreePath, linked, checks, missing, complete: missing.length === 0 };
}
