/**
 * Backend Adapter Interface
 *
 * Each AI CLI backend (Claude, Codex, Gemini) implements this interface
 * to handle identity injection, MCP config, and flag mapping.
 */

import type { BackendStreamParser } from './stream.js';

/** A media file attached to a turn (downloaded by channel listeners). */
export interface TurnMedia {
  /** Absolute path on disk. */
  path: string;
  /** Detected from extension; adapters filter by what they can inject. */
  mimeType?: string;
}

export interface BackendConfig {
  agentId: string;
  model?: string; // undefined = use backend's default model
  prompt?: string; // undefined = interactive mode
  promptParts: string[]; // raw positional args (preserves shell word boundaries)
  passthroughArgs: string[];
  startupContextBlock?: string; // optional injected startup context for backends that support it
  pcpSessionId?: string;
  backendSessionId?: string;
  backendSessionSeedId?: string;
  studioId?: string;
  dangerous?: boolean;
  /**
   * Directories containing turn attachments. Adapters that support it
   * grant the backend read access (claude: --add-dir per directory) so
   * attached files referenced in the prompt are readable without
   * permission prompts. Adapters without an equivalent flag may ignore
   * this — the attachment paths still appear in the prompt text.
   */
  attachmentDirs?: string[];
  /**
   * Opt this turn into structured streaming output. Adapters that support it
   * (claude: `--output-format stream-json --verbose`) add the flags; others
   * ignore it and run in plain-text mode.
   */
  stream?: boolean;
  /**
   * The chat loop's tool routing for this turn. 'local' = ink owns the
   * agentic loop (wholly-in-ink): the provider must not see tool-bearing MCP
   * servers, so adapters withhold them structurally (claude:
   * `--strict-mcp-config` + a config filtered to channel bridges and skill
   * servers). 'backend' or undefined = provider-owned loop; the MCP config
   * passes through unchanged. Callers outside the chat loop (awaken,
   * passthrough commands) omit this and keep today's behavior.
   */
  toolRouting?: 'backend' | 'local';
  /**
   * Media files attached to THIS turn (spec:provider-media-injection).
   * Adapters that inject media embed them in the prompt envelope (claude:
   * stream-json image content blocks; codex: `-i` flags) so the provider
   * needs no filesystem tool to see them. attachmentDirs remains the
   * native-read fallback for anything an adapter cannot inject.
   */
  media?: TurnMedia[];
}

export interface PreparedBackend {
  binary: string;
  args: string[];
  env: Record<string, string>;
  cleanup: () => void;
  /**
   * Prompt data to pass via stdin instead of argv. Large transcripts exceed
   * the OS argv limit (~256KB on macOS → spawn E2BIG), so adapters that
   * support reading the prompt from stdin should set this and omit the
   * prompt from args.
   */
  stdinData?: string;
}

export interface BackendAdapter {
  readonly name: string;
  readonly binary: string;

  /**
   * Whether prepare() embeds BackendConfig.media into the prompt envelope
   * (spec:provider-media-injection). Injecting adapters deliver media as
   * prompt CONTENT — claude: stream-json image blocks over stdin; codex:
   * `-i` flags — so wholly-in-ink routing needs no native filesystem tool
   * for the delivery turn. Non-injecting adapters fall back to the
   * attachment-gated native-read path.
   */
  readonly injectsMedia: boolean;

  /**
   * Prepare everything needed to spawn the backend process.
   * Writes temp files for identity injection, builds args, sets env vars.
   * Returns a cleanup function to remove temp files on exit.
   */
  prepare(config: BackendConfig): PreparedBackend;

  /**
   * Optional. Presence declares "this adapter emits a parseable event stream"
   * (when spawned with `stream: true`). Returns a FRESH per-turn parser that
   * turns raw stdout chunks into normalized `BackendTurnEvent`s. When absent,
   * the runner treats stdout as opaque response text (plain-text backends).
   */
  createStreamParser?(): BackendStreamParser;
}
