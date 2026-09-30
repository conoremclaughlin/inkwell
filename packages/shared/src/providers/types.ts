/**
 * Backend Adapter Interface
 *
 * Each AI CLI backend (Claude, Codex, Gemini) implements this interface
 * to handle identity injection, MCP config, and flag mapping.
 */

import type { BackendStreamParser } from './stream.js';
import type { SkillMcpServer } from './skill-mcp.js';

/**
 * What a provider spawn needs from the process that makes it, asked for by
 * name rather than read from that process's env, cwd or home. The CLI's host
 * answers from its own process, as the adapters once did themselves; a host
 * serving many sessions answers for each one, and never from its own.
 */
export interface BackendHost {
  readonly paths: {
    /** Inkwell's downloaded-media directory, granted read access when it exists. */
    readonly inkFiles: string;
    /** The ephemeral-studio root: created if missing, and granted at spawn. */
    readonly studiosRoot: string;
    /** Where per-spawn files (identity prompt, settings, MCP configs) are written. */
    readonly tempDir: string;
  };
  /**
   * The run's absolute deadline (epoch ms), when the host admitted one.
   * Every spawn of the run, continuations and compaction included, ends by
   * it: startBackendTurn clamps each spawn's hard ceiling to the time left
   * and starts none once it has passed, so no spawn restarts the run's
   * budget. The CLI's host has none.
   *
   * It is compared with this process's Date.now(), so compute it here, at
   * admission, as now plus the run's budget. Never derive it from a database
   * timestamp: the local database container's clock was measured freezing
   * across a host sleep (2026-09-23), which would make a derived deadline
   * early after a wake and refuse runs that have time left.
   */
  readonly deadlineAt?: number;
  /**
   * The routing a launcher inherits from the session it runs in. Read only
   * for a spawn that does not name its own (BackendConfig.explicitSession
   * unset), and then only for the MCP routing headers.
   */
  ambientSession(): { inkSessionId?: string; studioId?: string };
  /** Whether the installed claude accepts --include-partial-messages. */
  claudeSupportsPartialMessages(): Promise<boolean>;
  /** Skill-provided MCP servers visible from a working directory. */
  skillMcpServers(cwd: string): Promise<SkillMcpServer[]>;
  /**
   * The credentials for one spawn, asked for after preparation, just before
   * the spawn. `hardTimeoutMs` is the spawn's hard ceiling, already clamped
   * to `deadlineAt`: a host that mints makes them last that long, plus grace
   * to settle. A child stopped at its ceiling can keep running, and writing,
   * for STOP_GRACE_MS and then STOP_GIVE_UP_MS more (runner/spawn-backend.ts),
   * so size the grace from those. Routing names in the result are dropped
   * (see startBackendTurn).
   */
  sessionEnv(spawn: { hardTimeoutMs: number }): Promise<Record<string, string>>;
  /**
   * The environment the child inherits from, before the allowlist: HOME,
   * PATH and the like. Only SPAWN_ENV_INHERITED_NAMES cross
   * (runner/spawn-backend.ts), so a host key outside the list never reaches
   * the child. The CLI host answers with its own process env; a host serving
   * many sessions answers per session. This is the one source of the child's
   * HOME, and so of every config read from it.
   */
  baseEnv(): Promise<Readonly<Record<string, string | undefined>>>;
  /** The executable to spawn for an adapter's binary name. */
  resolveBinary(name: string): Promise<string>;
  /** A warning an adapter raises, such as media it could not inject. */
  warn(message: string): void;
}

/** A media file attached to a turn (downloaded by channel listeners). */
export interface TurnMedia {
  /** Absolute path on disk. */
  path: string;
  /** Detected from extension; adapters filter by what they can inject. */
  mimeType?: string;
}

export interface BackendConfig {
  sbSlug: string;
  model?: string; // undefined = use backend's default model
  /** Reasoning effort (claude: low | medium | high | xhigh | max). undefined = provider default. */
  effort?: string;
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
  /**
   * The directory the backend runs in, and the one its project config is read
   * from: `.mcp.json`, skills, the channel plugin. Required: a launcher that
   * runs in the user's own directory passes process.cwd() itself, and a host
   * that spawns for a session passes that session's, or the child would read
   * the host's config and load none of the studio's hooks.
   */
  cwd: string;
  /**
   * The caller named this spawn's session and studio, possibly as none. The
   * adapter then routes by exactly `inkSessionId` and `studioId`: no fallback
   * to the process env, and no session, studio or context header carried over
   * from the project config. Launchers that run in the user's own session
   * leave it unset and keep both.
   */
  explicitSession?: boolean;
  inkSessionId?: string;
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
  /**
   * Whether a human-facing process that can deliver inline messages owns
   * this spawn's session — carried in the INK_CONTEXT token the backend's
   * hooks read. The spawner knows; the adapter cannot. A child of a headless
   * `ink chat` inherits its parent's INK_SESSION_ID, so a child that claims
   * attachment marks the parent's session attached, and the trigger handler
   * then skips the spawn and delivers inline to nobody. Required, so no
   * spawner inherits an answer: a launcher in the user's terminal passes true.
   */
  cliAttached: boolean;
}

export interface PreparedBackend {
  binary: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Attempts to remove every per-spawn file prepare() wrote. Asynchronous,
   * so a host serving many sessions never blocks on it; callers await it
   * once the child has stopped. A prepare() that rejects has already made
   * the same attempt for what it wrote.
   *
   * Removal errors are swallowed, so a settled cleanup means the attempt
   * finished, not that every file is proven absent. It is not evidence that
   * anything the spawn held is released beyond the child having stopped.
   */
  cleanup: () => Promise<void>;
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
   * Returns a cleanup function to remove temp files on exit. Everything it
   * needs from the spawning process comes from `host`.
   */
  prepare(config: BackendConfig, host: BackendHost): Promise<PreparedBackend>;

  /**
   * Optional. Presence declares "this adapter emits a parseable event stream"
   * (when spawned with `stream: true`). Returns a FRESH per-turn parser that
   * turns raw stdout chunks into normalized `BackendTurnEvent`s. When absent,
   * the runner treats stdout as opaque response text (plain-text backends).
   */
  createStreamParser?(): BackendStreamParser;
}
