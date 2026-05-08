/**
 * Claude Code Permission Adapter
 *
 * Translates PCP permissions to Claude Code CLI flags and configuration.
 * Claude Code uses --allowedTools and permission settings in .claude/settings.json
 */

import type { PermissionAdapter, BackendPermissionConfig } from './types';
import type { EffectivePermissions, PermissionId } from '../../services/permissions';

/**
 * Mapping from PCP permissions to Claude Code tool/permission names
 */
const PERMISSION_MAPPING: Record<PermissionId, string[]> = {
  web_search: ['WebSearch'],
  web_fetch: ['WebFetch'],
  bash_curl: ['Bash(curl *)'], // Pattern for curl commands
  bash_general: ['Bash'], // General bash access
  file_read: ['Read', 'Glob', 'Grep'],
  file_write: ['Write', 'Edit'],
  mcp_tools: ['mcp__inkwell__*', 'mcp__supabase__*', 'mcp__github__*', 'mcp__playwright__*'],
};

/**
 * Risk descriptions for documentation
 */
const RISK_DESCRIPTIONS: Record<PermissionId, string> = {
  web_search: 'Search the web (read-only, low risk)',
  web_fetch: 'Fetch URLs (read-only, can access any public URL)',
  bash_curl: 'HTTP requests via curl (can send data externally)',
  bash_general: 'Execute shell commands (high risk)',
  file_read: 'Read files from filesystem',
  file_write: 'Modify files on filesystem',
  mcp_tools: 'Use MCP server tools',
};

export class ClaudeCodeAdapter implements PermissionAdapter {
  readonly backendId = 'claude-code';

  /**
   * Translate PCP permissions to Claude Code configuration
   *
   * Returns:
   * - allowedTools: Array of tool patterns to allow
   * - deniedTools: Array of tool patterns to deny
   * - settingsOverrides: Suggested .claude/settings.json changes
   */
  translate(permissions: EffectivePermissions): BackendPermissionConfig {
    const allowedTools: string[] = [];
    const deniedTools: string[] = [];
    const enabledDescriptions: string[] = [];
    const disabledDescriptions: string[] = [];

    for (const permissionId of this.getSupportedPermissions()) {
      const isEnabled = permissions.permissions.get(permissionId) ?? false;
      const tools = PERMISSION_MAPPING[permissionId] || [];
      const description = RISK_DESCRIPTIONS[permissionId];

      if (isEnabled) {
        allowedTools.push(...tools);
        enabledDescriptions.push(description);
      } else {
        deniedTools.push(...tools);
        disabledDescriptions.push(description);
      }
    }

    return {
      backend: this.backendId,
      config: {
        // These can be used to build CLI args or settings
        allowedTools,
        deniedTools,

        // Suggested CLI flags (for documentation)
        suggestedFlags: this.buildSuggestedFlags(allowedTools, deniedTools),

        // Settings.json format
        settingsFormat: {
          permissions: {
            allow: allowedTools,
            deny: deniedTools,
          },
        },
      },
      summary: {
        enabled: enabledDescriptions,
        disabled: disabledDescriptions,
      },
    };
  }

  getSupportedPermissions(): PermissionId[] {
    return Object.keys(PERMISSION_MAPPING) as PermissionId[];
  }

  supportsPermission(permissionId: PermissionId): boolean {
    return permissionId in PERMISSION_MAPPING;
  }

  /**
   * Build suggested CLI flags for Claude Code
   */
  private buildSuggestedFlags(allowed: string[], denied: string[]): string[] {
    const flags: string[] = [];

    // Note: Claude Code doesn't have direct CLI flags for tool permissions
    // Instead it uses settings files. This is for documentation.
    if (allowed.length > 0) {
      flags.push(`# Allowed tools: ${allowed.join(', ')}`);
    }
    if (denied.length > 0) {
      flags.push(`# Denied tools: ${denied.join(', ')}`);
    }

    return flags;
  }

  /**
   * Generate a system prompt addition that communicates permissions to Claude
   */
  generatePermissionPrompt(permissions: EffectivePermissions): string {
    const config = this.translate(permissions);
    const lines: string[] = [];

    lines.push('## Your Permissions');
    lines.push('');

    if (config.summary.enabled.length > 0) {
      lines.push('**Enabled:**');
      for (const desc of config.summary.enabled) {
        lines.push(`- ${desc}`);
      }
      lines.push('');
    }

    if (config.summary.disabled.length > 0) {
      lines.push('**Disabled (do not use):**');
      for (const desc of config.summary.disabled) {
        lines.push(`- ${desc}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

// Singleton instance
let claudeCodeAdapterInstance: ClaudeCodeAdapter | null = null;

export function getClaudeCodeAdapter(): ClaudeCodeAdapter {
  if (!claudeCodeAdapterInstance) {
    claudeCodeAdapterInstance = new ClaudeCodeAdapter();
  }
  return claudeCodeAdapterInstance;
}
