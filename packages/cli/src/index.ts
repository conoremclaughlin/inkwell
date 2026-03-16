/**
 * PCP CLI
 *
 * Programmatic API for PCP CLI functionality.
 * For CLI usage, see cli.ts
 */

export interface StudioIdentity {
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

/** @deprecated Use StudioIdentity */
export type WorkspaceIdentity = StudioIdentity;

export interface StudioInfo {
  name: string;
  path: string;
  branch: string;
  identity?: StudioIdentity;
}

/** @deprecated Use StudioInfo */
export type WorkspaceInfo = StudioInfo;

export interface PcpConfig {
  userId?: string;
  email?: string;
  agentMapping?: Record<string, string>;
  studioId?: string;
}

export interface CreateStudioOptions {
  name: string;
  agentId?: string;
  gitRoot?: string;
  purpose?: string;
}

/** @deprecated Use CreateStudioOptions */
export type CreateWorkspaceOptions = CreateStudioOptions;

// Re-export command modules for programmatic use
export { runClaude, runClaudeInteractive } from './commands/claude.js';
