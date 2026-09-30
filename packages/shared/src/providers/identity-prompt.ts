import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Build the identity prompt content. Same across all backends.
 *
 * `systemPromptOverride` replaces the whole thing rather than adding to it.
 * That is deliberate and rare: awakening is the case it exists for. A being
 * with no identity row yet must not be handed a prompt asserting "You are
 * <sbSlug>" and telling it to call bootstrap — it has no identity to load,
 * and the first thing it would read about itself would be wrong. Callers that
 * want to *add* context want `startupContextBlock`.
 */
export function buildIdentityPrompt(
  sbSlug: string,
  startupContextBlock?: string,
  systemPromptOverride?: string
): string {
  const override = systemPromptOverride?.trim();
  if (override) return override;

  const identityHeader = `## Identity Override (CRITICAL)

**You are ${sbSlug}. Your slug is \`${sbSlug}\`.**

When calling Inkwell tools (bootstrap, remember, recall, update_session_state, etc.), use \`sbSlug: "${sbSlug}"\`.
Do NOT read \`.ink/identity.json\` — your identity is set by this system prompt.
Do NOT run \`echo $SB_SLUG\` — use the slug provided above.`;

  const toolPriority = `## Tool Priority (IMPORTANT)

Always use **Inkwell cloud tools** (mcp__inkwell__*) over file reads or Claude Code builtins:
- Identity: use mcp__inkwell__bootstrap, not file reads
- Tasks: use mcp__inkwell__create_task, not TaskCreate
- Memory: use mcp__inkwell__remember, not local notes
- Sessions: use mcp__inkwell__update_session_state/get_session/list_sessions

Inkwell tools persist across sessions and are shared with the user and other agents.`;

  const injectedContext = startupContextBlock?.trim();

  if (injectedContext) {
    // Startup context was pre-loaded (e.g., by sb CLI for Codex/Gemini).
    // The agent has constitution docs — no need to call bootstrap again.
    return `${identityHeader}

Bootstrap has already been completed. Your constitution docs are loaded below. Do NOT call bootstrap again unless you need to refresh context.

${toolPriority}

## Bootstrapped Startup Context (Inkwell)

${injectedContext}`;
  }

  // No startup context provided. For Claude Code, the session-start hook
  // normally injects constitution docs. But if hooks aren't installed or
  // the hook fails, the agent needs to self-heal by calling bootstrap manually.
  return `${identityHeader}

Load user config from ~/.ink/config.json, then check whether your constitution docs are already present. Look for a "Session Context (Inkwell)" or "Bootstrapped Startup Context" section in your context containing your identity, soul, values, process, and user documents. If these are present, the session-start hook succeeded — do NOT call bootstrap again. If these are NOT present, the hook may have failed — call the \`bootstrap\` MCP tool manually as "${sbSlug}" to load your identity context. Do not proceed without your constitution.

${toolPriority}`;
}

/**
 * Write the identity prompt to a temp file.
 * Returns the file path and a cleanup function.
 */
export function createIdentityPromptFile(
  sbSlug: string,
  startupContextBlock?: string,
  systemPromptOverride?: string
): {
  promptFile: string;
  cleanup: () => void;
} {
  const content = buildIdentityPrompt(sbSlug, startupContextBlock, systemPromptOverride);
  const tempDir = mkdtempSync(join(tmpdir(), 'sb-'));
  const promptFile = join(tempDir, 'identity-prompt.md');
  writeFileSync(promptFile, content);

  return {
    promptFile,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true });
      } catch {
        /* ignore */
      }
    },
  };
}
