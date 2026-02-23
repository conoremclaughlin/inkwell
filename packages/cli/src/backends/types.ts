/**
 * Backend Adapter Interface
 *
 * Each AI CLI backend (Claude, Codex, Gemini) implements this interface
 * to handle identity injection, MCP config, and flag mapping.
 */

export interface BackendConfig {
  agentId: string;
  model?: string; // undefined = use backend's default model
  prompt?: string; // undefined = interactive mode
  promptParts: string[]; // raw positional args (preserves shell word boundaries)
  passthroughArgs: string[];
  pcpSessionId?: string;
  backendSessionId?: string;
}

export interface PreparedBackend {
  binary: string;
  args: string[];
  env: Record<string, string>;
  cleanup: () => void;
}

export interface BackendAdapter {
  readonly name: string;
  readonly binary: string;

  /**
   * Prepare everything needed to spawn the backend process.
   * Writes temp files for identity injection, builds args, sets env vars.
   * Returns a cleanup function to remove temp files on exit.
   */
  prepare(config: BackendConfig): PreparedBackend;
}
