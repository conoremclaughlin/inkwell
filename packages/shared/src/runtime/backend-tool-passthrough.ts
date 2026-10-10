/** The existing backend tool gate, shared by both hosts. */
import type { BackendToolGate } from './tool-policy.js';

export function buildBackendToolPassthrough(
  backend: string,
  toolRouting: 'backend' | 'local',
  gate: BackendToolGate,
  strictTools: boolean
): { passthroughArgs: string[]; warning?: string } {
  const shouldDisableBackendTools = toolRouting !== 'backend' || gate.mode === 'off';

  if (backend === 'claude') {
    if (shouldDisableBackendTools) {
      return { passthroughArgs: ['--allowedTools', ''] };
    }
    if (gate.mode === 'privileged') {
      return { passthroughArgs: [] };
    }
    return { passthroughArgs: ['--allowedTools', gate.allowedTools.join(',')] };
  }

  if (backend === 'gemini') {
    if (shouldDisableBackendTools) {
      return { passthroughArgs: ['--allowed-tools', ''] };
    }
    if (gate.mode === 'privileged') {
      return { passthroughArgs: [] };
    }
    return { passthroughArgs: ['--allowed-tools', gate.allowedTools.join(',')] };
  }

  if (backend === 'codex') {
    if (toolRouting === 'local' && strictTools) {
      return {
        passthroughArgs: [
          // Keep Codex execution deterministic in one-shot mode.
          // NOTE: for Codex `exec`, these are subcommand options and therefore
          // must be placed after `exec` (adapter handles ordering).
          '--color',
          'never',
          '--sandbox',
          'read-only',
          '--skip-git-repo-check',
          '--config',
          'features.apps=false',
          '--config',
          'mcp_servers.inkwell.enabled=false',
          '--config',
          'mcp_servers.next-devtools.enabled=false',
          '--config',
          'mcp_servers.github.enabled=false',
          '--config',
          'mcp_servers.supabase.enabled=false',
          '--config',
          'mcp_servers={}',
        ],
        warning:
          'Codex strict-tools mode enabled: forcing read-only sandbox, no color UI, and disabling known backend MCP servers.',
      };
    }
    if (shouldDisableBackendTools || gate.mode === 'backend') {
      return {
        passthroughArgs: [],
        warning:
          toolRouting === 'local'
            ? 'Codex CLI has no allowlist passthrough flag; relying on ink local-tool routing prompt guard.'
            : 'Codex CLI has no allowlist passthrough flag; backend tool gating is not enforced by CLI flags.',
      };
    }
  }

  return { passthroughArgs: [] };
}
