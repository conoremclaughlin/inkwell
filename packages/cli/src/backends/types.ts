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
  /**
   * Replace the generated identity prompt entirely, rather than adding to it.
   *
   * Exists for awakening: a being with no identity row yet must not be handed
   * a prompt that asserts who it is and tells it to bootstrap. Use
   * `startupContextBlock` to *add* context; use this only when the caller owns
   * the whole system prompt. Reaches the backend the same way the identity
   * prompt does (claude: --append-system-prompt, codex:
   * model_instructions_file, gemini: GEMINI_SYSTEM_MD).
   */
  systemPromptOverride?: string;
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
   * Media files for the LOGICAL turn (spec:provider-media-injection),
   * passed on every spawn of that turn — delivery, reseed, and tool-loop
   * continuations alike. Injecting adapters embed them in the prompt
   * envelope (claude: stream-json image content blocks; codex: `--image=`
   * flags re-attached per spawn, being stateless). Adapters without
   * injection support ignore this; attachmentDirs remains the native-read
   * fallback for explicitly unsupported types only.
   */
  media?: TurnMedia[];
  /**
   * True on DELIVERY spawns of the logical turn (initial and reseed) —
   * the spawns that must embed `media` into the prompt envelope. Omitted
   * on same-turn tool-loop continuations, whose resumed provider session
   * already holds the images. This is an explicit signal because
   * backendSessionId alone cannot distinguish "continuation of this turn"
   * from "new media delivered into a resumed cross-process conversation"
   * (server heartbeat/reattach) — the latter MUST embed.
   */
  deliverMedia?: boolean;
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
   * How the FULL prompt reaches the provider process. 'stdin' has no size
   * ceiling; 'argv' passes the prompt as a positional argument and is bounded
   * by the OS ARG_MAX (~1MB total on macOS) — context budgets for argv
   * transports must stay small enough that a full reseed prompt can never
   * exceed it (see ARGV_TRANSPORT_BUDGET_CAP in repl/context-limits.ts).
   * Migrating an adapter to stdin delivery is what unlocks large-window
   * budgets for its backend.
   */
  readonly promptTransport: 'stdin' | 'argv';

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
