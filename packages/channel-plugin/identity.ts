/**
 * The channel plugin's identity resolution.
 *
 * Deliberately its own module with NO side effects. index.ts evaluates a
 * logger, reads credentials off disk, writes a "Channel plugin starting" line
 * and constructs an MCP Server at module scope — so a test reaching in there
 * for this one function does all of that on import (Lumen, PR #635).
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export function resolveSlug(): string {
  // Plugin-specific override first, then the documented primary, then the
  // pre-rename names that long-running processes still carry.
  if (process.env.INK_SB_SLUG) return process.env.INK_SB_SLUG;
  if (process.env.INK_AGENT_ID) return process.env.INK_AGENT_ID;
  if (process.env.SB_SLUG) return process.env.SB_SLUG;
  if (process.env.AGENT_ID) return process.env.AGENT_ID;

  // Try .ink/identity.json in cwd. This is a SECOND reader of that file — it
  // does not share the CLI's readIdentityJson funnel — so the legacy key has
  // to be normalized here too, or an existing file resolves to the 'wren'
  // fallback and this plugin polls under the wrong identity (Lumen, PR #635).
  const identityPath = join(process.cwd(), '.ink', 'identity.json');
  if (existsSync(identityPath)) {
    try {
      const identity = JSON.parse(readFileSync(identityPath, 'utf-8'));
      const slug = identity.sbSlug ?? identity.agentId;
      if (typeof slug === 'string' && slug) return slug;
    } catch {
      // ignore
    }
  }

  return 'wren'; // fallback
}
