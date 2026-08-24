/**
 * Studio Bootstrap
 *
 * One entry point for making a freshly-created worktree usable by an agent.
 *
 * `.mcp.json` and `.env.local` are gitignored, so `git worktree add` brings
 * neither — a new studio starts with no MCP configuration at all. Whoever
 * creates the worktree has to seed it, and there are two creators: `ink studio
 * new` in the CLI and the `create_studio` MCP tool on the server. Only the CLI
 * ever did, which left agent-created studios with no `.mcp.json` (so Claude
 * sessions got no MCP tools) and no `.codex/config.toml` (so Codex spawned
 * against a partial `[mcp_servers.inkwell]` and died on "invalid transport").
 *
 * Both callers go through bootstrapStudio() so the two can't drift again.
 */

import { existsSync, cpSync } from 'fs';
import { join } from 'path';
import { syncMcpConfig } from './mcp-config-sync.js';

/** Local-only files a worktree needs but git will never provide. */
export const BOOTSTRAP_FILES = ['.mcp.json', '.env.local'] as const;

export interface BootstrapStudioResult {
  /** Files copied in from the source root (absent ones are skipped). */
  copied: string[];
  /** Whether `.codex/config.toml` was written. */
  codex: boolean;
  /** Whether `.gemini/settings.json` was written. */
  gemini: boolean;
}

/**
 * Copy `.mcp.json` and `.env.local` into a studio when missing.
 *
 * Never overwrites: a studio that has already been customised keeps its own
 * copy. Returns the files actually copied.
 */
export function copyBootstrapFiles(sourceRoot: string, studioPath: string): string[] {
  if (sourceRoot === studioPath) return [];

  const copied: string[] = [];
  for (const file of BOOTSTRAP_FILES) {
    const source = join(sourceRoot, file);
    const target = join(studioPath, file);
    if (existsSync(source) && !existsSync(target)) {
      cpSync(source, target);
      copied.push(file);
    }
  }
  return copied;
}

/**
 * Seed a new studio's local config, then generate the per-backend files.
 *
 * Order matters: syncMcpConfig reads `.mcp.json` from the studio, so the copy
 * has to land first or the sync silently no-ops and the studio ships without a
 * `.codex/config.toml`.
 *
 * Best-effort by design — a studio that fails to bootstrap is still a usable
 * worktree, and callers should not abort worktree creation over it.
 */
export function bootstrapStudio(sourceRoot: string, studioPath: string): BootstrapStudioResult {
  const copied = copyBootstrapFiles(sourceRoot, studioPath);
  const { codex, gemini } = syncMcpConfig(studioPath);
  return { copied, codex, gemini };
}
