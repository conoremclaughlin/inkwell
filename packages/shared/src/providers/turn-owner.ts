/**
 * Who owns a backend process's logical turn.
 *
 * `ink chat` runs each provider step as a child process that inherits the
 * chat's INK_SESSION_ID. The chat process owns that session's logical turn:
 * its turn signal opens the marker before the first step and closes it after
 * the last. The child's hooks would otherwise write the session's lifecycle
 * as if the child were the whole turn.
 *
 * The hooks treat a headless child's `cliAttached:false` as a detach, and the
 * lifecycle route clears `cli_turn_at` on a detach, because a server spawn's
 * detach is proof that no interactive process is left. A chat child is not
 * that proof. Its parent is still running, and with no server run registered
 * for a locally started chat, the marker is the only protection the turn has
 * (Lumen, PR #685 r2). So a child spawned by chat declares that its parent
 * owns the turn, and its on-prompt hook leaves the attachment alone.
 *
 * The attachment is then the parent's to write. A headless chat declares
 * `cliAttached:false` in the prompt request that opens each turn
 * (repl/turn-signal.ts). A prompt request stamps the marker whatever else it
 * carries, so the false clears an attachment a crashed interactive process
 * left behind without detaching the turn (Lumen, PR #685 r3).
 *
 * Carried in the environment and not in INK_CONTEXT, so that hooks built from
 * any checkout can read it without a rebuild of @inklabs/shared.
 */
export const TURN_OWNER_ENV = 'INK_TURN_OWNER';
export const PARENT_TURN_OWNER = 'parent';

/** Environment for every provider process `ink chat` spawns. */
export const PARENT_OWNED_TURN_ENV: Record<string, string> = {
  [TURN_OWNER_ENV]: PARENT_TURN_OWNER,
};

/**
 * True when a parent `ink chat` process owns the logical turn of the process
 * whose env this is. The env is the caller's to name: a hook passes its own
 * process's, and nothing on a spawn's preparation path reads one ambiently.
 */
export function parentOwnsTurn(env: NodeJS.ProcessEnv): boolean {
  return env[TURN_OWNER_ENV] === PARENT_TURN_OWNER;
}

/**
 * Whether the INK_CONTEXT token in `env` declares a headless spawn
 * (`cliAttached:false`), as a server spawn's does. No token, or one that does
 * not decode, is an interactive process.
 */
export function contextDeclaresHeadless(env: NodeJS.ProcessEnv): boolean {
  const raw = env.INK_CONTEXT?.trim();
  if (!raw) return false;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString()) as {
      cliAttached?: unknown;
    };
    return parsed.cliAttached === false;
  } catch {
    return false;
  }
}

/**
 * The `cli_attached` value a backend's on-prompt hook writes to its session:
 * true for an interactive process, false for a server spawn (it clears an
 * attachment a crashed interactive process left behind), and null, meaning
 * no write, for a headless child of `ink chat`, whose parent declares it.
 */
export function promptAttachmentWrite(headless: boolean, env: NodeJS.ProcessEnv): boolean | null {
  if (!headless) return true;
  return parentOwnsTurn(env) ? null : false;
}
