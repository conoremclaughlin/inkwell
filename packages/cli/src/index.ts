/**
 * PCP CLI
 *
 * Programmatic API for PCP CLI functionality.
 * For CLI usage, see cli.ts
 */

export interface WorkspaceIdentity {
  agentId: string;
  identityId?: string;
  context: string;
  description: string;
  studioId?: string;
  studio: string;
  branch: string;
  createdAt: string;
  createdBy?: string;
  /** @deprecated Use studio */
  workspace?: string;
}

export interface WorkspaceInfo {
  name: string;
  path: string;
  branch: string;
  identity?: WorkspaceIdentity;
}

export interface PcpConfig {
  userId?: string;
  email?: string;
  agentMapping?: Record<string, string>;
  studioId?: string;
  /** @deprecated Use studioId */
  workspaceId?: string;
}

export interface CreateWorkspaceOptions {
  name: string;
  agentId?: string;
  gitRoot?: string;
  purpose?: string;
}

// Re-export command modules for programmatic use
export { runClaude, runClaudeInteractive } from './commands/claude.js';
