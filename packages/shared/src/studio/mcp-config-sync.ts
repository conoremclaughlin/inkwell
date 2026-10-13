/**
 * MCP Config Sync
 *
 * Converts a repo's `.mcp.json` into the per-backend formats Codex
 * (`.codex/config.toml`) and Gemini (`.gemini/settings.json`) expect.
 *
 * Lives in shared, not the CLI, because studios get created from two places —
 * `ink studio new` and the `create_studio` MCP tool — and both must bootstrap a
 * worktree identically. When only the CLI did this, agent-created studios
 * landed with no `.mcp.json` and no `.codex/config.toml`; Codex then spawned
 * against a partial `[mcp_servers.inkwell]` and died on "invalid transport",
 * while Claude sessions there simply had no MCP tools at all.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync } from 'fs';
import { join } from 'path';
import { formatTomlPath, readTomlDefinitions, type TomlStatement } from './toml-definitions.js';
import { pinIsolatedPlaywright } from './playwright-mcp.js';

export interface McpServerConfig {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface McpJson {
  mcpServers: Record<string, McpServerConfig>;
}
const CODEX_MANAGED_START = '# ink-managed:start mcp_servers';
const CODEX_MANAGED_END = '# ink-managed:end mcp_servers';
// Backward compat: detect old markers during replacement
const CODEX_MANAGED_START_LEGACY = '# pcp-managed:start mcp_servers';
const CODEX_MANAGED_END_LEGACY = '# pcp-managed:end mcp_servers';
// ============================================================================
// Env file parsing
// ============================================================================

/**
 * Parse a .env file into key-value pairs.
 * Handles comments, empty lines, quoted values, and inline comments.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};

  const vars: Record<string, string> = {};
  const content = readFileSync(filePath, 'utf-8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip inline comments for unquoted values
      const commentIdx = value.indexOf(' #');
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx).trim();
      }
    }

    if (key) vars[key] = value;
  }

  return vars;
}

/**
 * Scan a server config for ${VAR} template references.
 * Returns the set of variable names referenced.
 */
export function findTemplateVars(config: McpServerConfig): Set<string> {
  const vars = new Set<string>();
  const pattern = /\$\{(\w+)\}/g;

  function scan(val: unknown): void {
    if (typeof val === 'string') {
      for (const match of val.matchAll(pattern)) {
        vars.add(match[1]);
      }
    } else if (val && typeof val === 'object') {
      for (const v of Object.values(val)) {
        scan(v);
      }
    }
  }

  scan(config);
  return vars;
}

/**
 * Inject .env.local values into server configs for vars referenced via ${VAR} syntax.
 * Returns a new servers map with env vars injected — does not mutate the input.
 */
function injectEnvLocal(
  servers: Record<string, McpServerConfig>,
  envVars: Record<string, string>
): Record<string, McpServerConfig> {
  if (Object.keys(envVars).length === 0) return servers;

  const result: Record<string, McpServerConfig> = {};

  for (const [name, config] of Object.entries(servers)) {
    const referencedVars = findTemplateVars(config);
    const injected: Record<string, string> = {};

    for (const varName of referencedVars) {
      if (envVars[varName] && !config.env?.[varName]) {
        injected[varName] = envVars[varName];
      }
    }

    if (Object.keys(injected).length > 0) {
      result[name] = {
        ...config,
        env: { ...injected, ...config.env },
      };
    } else {
      result[name] = config;
    }
  }

  return result;
}

// ============================================================================
// Format converters
// ============================================================================

/** Headers that say which session and studio a request serves. */
const ROUTING_HEADER_NAMES: ReadonlySet<string> = new Set([
  'x-ink-session-id',
  'x-ink-studio-id',
  'x-ink-context',
]);

/**
 * The headers a generated backend config may carry: every configured header
 * except routing ones. Routing is per session, and the adapters supply it
 * from the spawn's own env (Codex: env_http_headers; Gemini: its generated
 * system settings). Baked into a studio file it is one session's value,
 * sent on behalf of every session that runs there. Names match
 * case-insensitively, as HTTP does.
 */
function withoutRoutingHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const kept = Object.entries(headers).filter(
    ([name]) => !ROUTING_HEADER_NAMES.has(name.toLowerCase())
  );
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * Convert .mcp.json servers to Codex TOML format.
 * Only emits the [mcp_servers.*] sections.
 */
function toCodexToml(servers: Record<string, McpServerConfig>): string {
  const lines: string[] = [
    '# Generated by `ink mcp sync` from .mcp.json',
    '# Re-run `ink mcp sync` after changing .mcp.json',
    '',
  ];

  for (const [name, config] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);

    if (config.url) {
      lines.push(`url = ${tomlString(config.url)}`);
    }

    // Inkwell server: mark as required so Codex fails loudly if it can't connect
    if (name === 'inkwell') {
      lines.push('required = true');
    }

    if (config.command) {
      lines.push(`command = ${tomlString(config.command)}`);
    }

    if (config.args?.length) {
      lines.push(`args = [${config.args.map(tomlString).join(', ')}]`);
    }

    // Codex only supports `env` for stdio servers, not streamable_http (url-based)
    if (config.env && Object.keys(config.env).length > 0 && !config.url) {
      const pairs = Object.entries(config.env)
        .map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`)
        .join(', ');
      lines.push(`env = { ${pairs} }`);
    }

    const headers = withoutRoutingHeaders(config.headers);
    if (headers) {
      // Detect "Authorization: Bearer ${ENV_VAR}" pattern → Codex bearer_token_env_var
      const authHeader = headers['Authorization'] || headers['authorization'];
      const bearerMatch = authHeader?.match(/^Bearer \$\{(\w+)\}$/);

      if (bearerMatch) {
        lines.push(`bearer_token_env_var = ${tomlString(bearerMatch[1])}`);
        // Emit remaining non-auth headers as http_headers if any
        const remaining = Object.entries(headers).filter(
          ([k]) => k.toLowerCase() !== 'authorization'
        );
        if (remaining.length > 0) {
          const pairs = remaining.map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(', ');
          lines.push(`http_headers = { ${pairs} }`);
        }
      } else {
        const pairs = Object.entries(headers)
          .map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`)
          .join(', ');
        lines.push(`http_headers = { ${pairs} }`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

function renderCodexManagedBlock(servers: Record<string, McpServerConfig>): string {
  const body = toCodexToml(servers).trimEnd();
  return `${CODEX_MANAGED_START}\n${body}\n${CODEX_MANAGED_END}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTomlSectionHeader(line: string): boolean {
  return /^\s*\[[^\]]+\]\s*$/.test(line);
}

function isMcpSectionHeader(line: string): boolean {
  return /^\s*\[mcp_servers(?:\.[^\]]+)?\]\s*$/.test(line);
}

function stripLegacyMcpSections(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!isMcpSectionHeader(lines[i])) {
      kept.push(lines[i]);
      i += 1;
      continue;
    }

    // Skip current MCP section until the next TOML section header
    i += 1;
    while (i < lines.length && !isTomlSectionHeader(lines[i])) {
      i += 1;
    }

    // Also skip blank lines directly after removed section to avoid extra gaps
    while (i < lines.length && lines[i].trim() === '') {
      i += 1;
    }

    if (kept.length > 0 && kept[kept.length - 1] !== '') {
      kept.push('');
    }
  }

  return kept.join('\n');
}

function stripLegacySyncHeaders(content: string): string {
  const filtered = content
    .split('\n')
    .filter(
      (line) =>
        line.trim() !== '# Generated by `ink mcp sync` from .mcp.json' &&
        line.trim() !== '# Re-run `ink mcp sync` after changing .mcp.json'
    );
  return filtered.join('\n');
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

/** The pattern of the managed block in `existing` (current or legacy markers), if it has one. */
function managedBlockPattern(existing: string): RegExp | undefined {
  const hasCurrentBlock =
    existing.includes(CODEX_MANAGED_START) && existing.includes(CODEX_MANAGED_END);
  const hasLegacyBlock =
    existing.includes(CODEX_MANAGED_START_LEGACY) && existing.includes(CODEX_MANAGED_END_LEGACY);
  if (!hasCurrentBlock && !hasLegacyBlock) return undefined;
  const startMarker = hasCurrentBlock ? CODEX_MANAGED_START : CODEX_MANAGED_START_LEGACY;
  const endMarker = hasCurrentBlock ? CODEX_MANAGED_END : CODEX_MANAGED_END_LEGACY;
  return new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`, 'm');
}

/** A Codex config read against ink's managed block. */
export interface CodexConfigReading {
  /** 1-based line of the statement that could not be read; nothing after it was judged. */
  unreadableLine?: number;
  /** Paths defined more than once, which Codex refuses to parse, as `a.b`. */
  redefined: string[];
  /** The same, where both definitions sit outside ink's managed block, so no sync removes either. */
  redefinedOutsideBlock: string[];
  /** Servers whose definition in the managed block collides with one outside it. */
  collidingWithBlock: string[];
  /** Whether the inkwell server's own table is defined, in any spelling. */
  definesInkwell: boolean;
  /** Whether that definition sits outside ink's managed block, in a file that has one. */
  inkwellOutsideBlock: boolean;
}

/** 0-based lines of the managed block's markers, current markers first, as managedBlockPattern picks. */
function managedBlockLines(lines: string[]): { start: number; end: number } | undefined {
  for (const [startMarker, endMarker] of [
    [CODEX_MANAGED_START, CODEX_MANAGED_END],
    [CODEX_MANAGED_START_LEGACY, CODEX_MANAGED_END_LEGACY],
  ] as const) {
    const start = lines.findIndex((line) => line.trim() === startMarker);
    const end =
      start === -1 ? -1 : lines.findIndex((line, i) => i > start && line.trim() === endMarker);
    if (end !== -1) return { start, end };
  }
  return undefined;
}

/**
 * Read a Codex config by what its keys resolve to (readTomlDefinitions), and
 * say which definitions sit inside ink's managed block. The sync rewrites
 * only that block, so a server defined outside it stays; the block must not
 * define it again, or Codex refuses the whole file (lumen-alpha, 2026-09-29,
 * #701).
 */
export function readCodexConfig(toml: string): CodexConfigReading {
  const definitions = readTomlDefinitions(toml);
  const block = managedBlockLines(toml.split('\n'));
  // Statement lines are 1-based; the markers' are 0-based.
  const inBlock = (statement: TomlStatement) =>
    !!block && statement.line - 1 > block.start && statement.line - 1 < block.end;
  const serverOf = (statement: TomlStatement) =>
    statement.path[0] === 'mcp_servers' && statement.path.length > 1
      ? statement.path[1]
      : undefined;

  const redefined = new Set<string>();
  const redefinedOutsideBlock = new Set<string>();
  const collidingWithBlock = new Set<string>();
  for (const { path, first, second } of definitions.redefinitions) {
    redefined.add(formatTomlPath(path));
    const managed = [second, first].find(inBlock);
    const server = managed ? serverOf(managed) : undefined;
    if (server !== undefined) collidingWithBlock.add(server);
    else if (!managed) redefinedOutsideBlock.add(formatTomlPath(path));
  }
  const inkwell = definitions.definedBy(['mcp_servers', 'inkwell']);
  return {
    ...(definitions.unreadableLine !== undefined
      ? { unreadableLine: definitions.unreadableLine }
      : {}),
    redefined: [...redefined],
    redefinedOutsideBlock: [...redefinedOutsideBlock],
    collidingWithBlock: [...collidingWithBlock],
    definesInkwell: !!inkwell,
    inkwellOutsideBlock: !!inkwell && !!block && !inBlock(inkwell),
  };
}

function mergeCodexConfig(existing: string | undefined, managedBlock: string): string {
  if (!existing || existing.trim() === '') {
    return managedBlock;
  }

  const pattern = managedBlockPattern(existing);
  if (pattern) {
    return ensureTrailingNewline(existing.replace(pattern, managedBlock));
  }

  // Back-compat: strip legacy generated MCP sections while preserving unrelated config (e.g. hooks)
  const cleaned = stripLegacySyncHeaders(stripLegacyMcpSections(existing)).trimEnd();
  if (!cleaned) {
    return managedBlock;
  }

  return ensureTrailingNewline(`${cleaned}\n\n${managedBlock}`);
}

function tomlString(val: string): string {
  return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Convert .mcp.json servers to Gemini settings.json format.
 * Merges into existing settings.json if present.
 */
function toGeminiSettings(
  servers: Record<string, McpServerConfig>,
  existingSettings?: Record<string, unknown>
): Record<string, unknown> {
  const geminiServers: Record<string, Record<string, unknown>> = {};

  for (const [name, config] of Object.entries(servers)) {
    const server: Record<string, unknown> = {};

    if (config.type) {
      server.type = config.type;
    }

    if (config.url) {
      server.url = config.url;
    }

    if (config.command) {
      server.command = config.command;
    }

    if (config.args?.length) {
      server.args = config.args;
    }

    if (config.env && Object.keys(config.env).length > 0) {
      server.env = config.env;
    }

    const headers = withoutRoutingHeaders(config.headers);
    if (headers) {
      server.headers = headers;
    }

    geminiServers[name] = server;
  }

  return {
    ...existingSettings,
    mcpServers: geminiServers,
  };
}

// ============================================================================
// Gitignore helper
// ============================================================================

function ensureGitignoreEntries(repoRoot: string, entries: string[]): string[] {
  const gitignorePath = join(repoRoot, '.gitignore');
  const added: string[] = [];

  let content = '';
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, 'utf-8');
  }

  const lines = content.split('\n');
  const missing = entries.filter((entry) => !lines.some((line) => line.trim() === entry));

  if (missing.length > 0) {
    const suffix = content.endsWith('\n') ? '' : '\n';
    const block = `${suffix}\n# Backend-specific config (generated by ink mcp sync)\n${missing.join('\n')}\n`;
    writeFileSync(gitignorePath, content + block);
    added.push(...missing);
  }

  return added;
}

/**
 * Core sync logic: read .mcp.json from targetDir and write .codex/ and .gemini/ configs.
 */
/**
 * True when the path is a symlink (dangling or not). Generated config is
 * never written through a link: a checkout can ship `.codex`, `.gemini`, or
 * the final file as a link to anywhere, and the write would land outside the
 * studio (Lumen, PR #604 round 2).
 */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The managed block and the file it makes, leaving out every server whose
 * definition collides with one outside the block. Each pass renders the
 * block, reads the merged file as Codex would, and drops the servers it
 * charges a redefinition to, until none is charged; dropping a definition
 * never makes a new collision, so each pass drops at least one or ends.
 *
 * The last reading is the check on what would be written. A file it cannot
 * read, or one still defining something twice, is not `checked`, and the
 * caller leaves the file as it was: Codex does not start at all on a config
 * it cannot parse (Myra, #701 73a3b6fd).
 */
function mergeCodexServers(
  existing: string | undefined,
  servers: Record<string, McpServerConfig>
): { merged: string; checked: boolean; keptOutside: string[]; handEdit: string[] } {
  const managed = { ...servers };
  const keptOutside: string[] = [];
  for (;;) {
    const merged = mergeCodexConfig(existing, renderCodexManagedBlock(managed));
    const reading = readCodexConfig(merged);
    const colliding = reading.collidingWithBlock.filter((name) => Object.hasOwn(managed, name));
    if (reading.unreadableLine === undefined && colliding.length > 0) {
      for (const name of colliding) delete managed[name];
      keptOutside.push(...colliding);
      continue;
    }
    const checked = reading.unreadableLine === undefined && reading.redefined.length === 0;
    // Fixed strings, key paths and line numbers only: never a value.
    const handEdit: string[] = [];
    if (reading.unreadableLine !== undefined) {
      handEdit.push(
        `.codex/config.toml could not be read at line ${reading.unreadableLine}, so the sync left it unchanged: fix that line, then run \`ink mcp sync\``
      );
    }
    if (reading.redefinedOutsideBlock.length > 0) {
      handEdit.push(
        `.codex/config.toml defines [${reading.redefinedOutsideBlock.join('], [')}] more than once outside ink's managed block, which Codex cannot parse, so the sync left it unchanged: remove one, then run \`ink mcp sync\``
      );
    }
    if (checked && keptOutside.includes('inkwell')) {
      handEdit.push(
        ".codex/config.toml defines the inkwell server outside ink's managed block, where the sync cannot update it: remove that definition, then run `ink mcp sync`"
      );
    }
    return { merged, checked, keptOutside: checked ? keptOutside.sort() : [], handEdit };
  }
}

export function syncMcpConfig(
  targetDir: string,
  options?: { sourceMcpPath?: string; sourceEnvPath?: string }
): {
  codex: boolean;
  gemini: boolean;
  /** Servers the Codex block left out because the file defines them outside it. */
  codexKeptOutside?: string[];
  /**
   * What the sync could not repair in .codex/config.toml, for a human to
   * edit. With `codex: false`, the sync left the file as it was.
   */
  codexHandEdit?: string[];
} {
  const mcpPath = options?.sourceMcpPath || join(targetDir, '.mcp.json');

  if (!existsSync(mcpPath)) {
    return { codex: false, gemini: false };
  }

  let mcpJson: McpJson;
  try {
    mcpJson = JSON.parse(readFileSync(mcpPath, 'utf-8'));
  } catch {
    return { codex: false, gemini: false };
  }

  if (!mcpJson.mcpServers || Object.keys(mcpJson.mcpServers).length === 0) {
    return { codex: false, gemini: false };
  }

  // --- Resolve env vars from .env.local ---
  const sourceEnv = options?.sourceEnvPath ? parseEnvFile(options.sourceEnvPath) : {};
  const targetEnv = parseEnvFile(join(targetDir, '.env.local'));
  const envLocal = { ...sourceEnv, ...targetEnv };
  // Codex and Gemini launch Playwright the way every session does: headless
  // and isolated, unless the entry names a browser of its own.
  const servers = pinIsolatedPlaywright(injectEnvLocal(mcpJson.mcpServers, envLocal)).servers;

  // --- Codex: .codex/config.toml ---
  const codexDir = join(targetDir, '.codex');
  const codexPath = join(codexDir, 'config.toml');
  let codex = false;
  let codexKeptOutside: string[] = [];
  let codexHandEdit: string[] = [];
  if (!isSymlink(codexDir) && !isSymlink(codexPath)) {
    mkdirSync(codexDir, { recursive: true });
    const existingCodex = existsSync(codexPath) ? readFileSync(codexPath, 'utf-8') : undefined;
    // A server already defined outside the block keeps that definition,
    // since the sync never rewrites outside its block; the block leaves it out.
    const { merged, checked, keptOutside, handEdit } = mergeCodexServers(existingCodex, servers);
    codexKeptOutside = keptOutside;
    codexHandEdit = handEdit;
    if (checked) {
      writeFileSync(codexPath, merged);
      codex = true;
    }
  }

  // --- Gemini: .gemini/settings.json ---
  const geminiDir = join(targetDir, '.gemini');
  const geminiPath = join(geminiDir, 'settings.json');
  let gemini = false;
  if (!isSymlink(geminiDir) && !isSymlink(geminiPath)) {
    mkdirSync(geminiDir, { recursive: true });

    let existingGemini: Record<string, unknown> | undefined;
    if (existsSync(geminiPath)) {
      try {
        existingGemini = JSON.parse(readFileSync(geminiPath, 'utf-8'));
      } catch {
        /* overwrite if unparseable */
      }
    }

    const geminiSettings = toGeminiSettings(servers, existingGemini);
    writeFileSync(geminiPath, JSON.stringify(geminiSettings, null, 2) + '\n');
    gemini = true;
  }

  // --- Gitignore --- (same rule: a linked .gitignore is not ours to append to)
  if (!isSymlink(join(targetDir, '.gitignore'))) {
    ensureGitignoreEntries(targetDir, ['.codex/', '.gemini/']);
  }

  return {
    codex,
    gemini,
    ...(codexKeptOutside.length > 0 ? { codexKeptOutside } : {}),
    ...(codexHandEdit.length > 0 ? { codexHandEdit } : {}),
  };
}
