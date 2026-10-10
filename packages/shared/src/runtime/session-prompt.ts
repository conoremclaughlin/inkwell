/** Shared prompt and provider-continuity policy; no host I/O or credential access. */
import { estimateTokens, type ContextLedger } from './context-ledger.js';
import {
  computeContextOccupancy,
  type ContextOccupancy,
  type ProviderContextMeasurement,
} from './context-tools.js';

export interface SessionPromptSkill {
  name: string;
  source: string;
  content?: string;
}

/** Only the fields rendered into the prompt, not a CLI runtime or host object. */
export interface SessionPromptState {
  backend: string;
  model?: string;
  systemPromptOverride?: string;
  maxContextTokens: number;
  toolMode: string;
  toolRouting: 'backend' | 'local';
  strictTools: boolean;
  threadKey?: string;
  activeSkills: readonly SessionPromptSkill[];
  bootstrapContext?: string;
}

export function renderActiveSkills(skills: readonly SessionPromptSkill[]): string {
  if (skills.length === 0) return '';
  return skills
    .map(
      (skill) =>
        `\n[Active skill: ${skill.name} from ${skill.source}]\n${skill.content || '(no skill content loaded)'}`
    )
    .join('\n');
}

export function formatBootstrapContext(result: Record<string, unknown>): string {
  const sections: string[] = [];

  // Identity files — the core of who the agent is
  const files = result.identityFiles as Record<string, string> | undefined;
  if (files) {
    if (files.values) sections.push(`--- VALUES.md ---\n${files.values.trim()}`);
    if (files.user) sections.push(`--- USER.md ---\n${files.user.trim()}`);
    if (files.soul) sections.push(`--- SOUL.md ---\n${files.soul.trim()}`);
    if (files.self) sections.push(`--- IDENTITY.md ---\n${files.self.trim()}`);
    if (files.process) sections.push(`--- PROCESS.md ---\n${files.process.trim()}`);
  }

  // Active projects + focus
  const ctx = result.activeContext as Record<string, unknown> | undefined;
  if (ctx) {
    const focus = ctx.focus as Record<string, string> | undefined;
    if (focus?.summary) {
      sections.push(`--- Current Focus ---\n${focus.summary}`);
    }
    const projects = ctx.projects as Array<Record<string, unknown>> | undefined;
    if (projects && projects.length > 0) {
      const lines = projects.map((p) => `- ${p.name} (${p.status}): ${p.description}`);
      sections.push(`--- Active Projects ---\n${lines.join('\n')}`);
    }
  }

  // Recent memories (knowledgeSummary is pre-formatted by bootstrap)
  const memories = result.knowledgeSummary as string | undefined;
  if (memories) {
    sections.push(`--- Recent Memories ---\n${memories}`);
  }

  // Skills
  const skills = result.skills as Array<Record<string, unknown>> | undefined;
  if (skills && skills.length > 0) {
    const eligible = skills.filter((s) => s.eligible);
    if (eligible.length > 0) {
      const lines = eligible.map((s) => `- ${s.displayName}: ${s.description}`);
      sections.push(`--- Available Skills ---\n${lines.join('\n')}`);
    }
  }

  if (sections.length === 0) return '';
  return sections.join('\n\n');
}

/**
 * How a tool-loop continuation reaches the provider.
 *
 * `resume`: the live native session holds the history — send the delta only.
 * `seed`: the session was rolled MID-TURN (an eviction, a trim, a budget
 * change, an uncorrected protocol break) — mint a fresh id, send the full
 * envelope, and persist the id so later continuations and the next turn
 * resume it. Before this existed the rolled continuation spawned UNSEEDED:
 * every further continuation re-packed the whole window into yet another
 * unresumable session — five fresh provider sessions in seven minutes,
 * 280–520K cache-creation tokens each (Myra, 2026-09-02; #572).
 * `stateless`: the backend cannot resume at all — full envelope every time.
 *
 * Pure, and called by runTurnForLoop itself, so the test pins the decision
 * the runtime makes rather than a mirror of it.
 */
export function decideContinuationSession(
  canReuse: boolean,
  activeId: string | undefined,
  mint: () => string
): { mode: 'resume'; id: string } | { mode: 'seed'; id: string } | { mode: 'stateless' } {
  if (!canReuse) return { mode: 'stateless' };
  if (activeId !== undefined) return { mode: 'resume', id: activeId };
  return { mode: 'seed', id: mint() };
}

/** Ceiling on the transient dialogue carried into a mid-turn reseed. */
export const MID_TURN_RESEED_MAX_CHARS = 30_000;

/**
 * One side of the transient dialogue a mid-turn reseed replays: what the
 * model said, or what the runtime said back.
 */
export interface ReseedDialogueEntry {
  role: 'assistant' | 'runtime' | 'user';
  text: string;
}

/**
 * The latest-message body for a mid-turn reseed: this turn's dialogue so far,
 * in order, ending with the continuation the model was about to receive.
 *
 * A rebuilt envelope carries the ledger — the user's message, tool-result
 * previews — but not the turn in progress. Assistant text alone was not
 * enough either (Lumen, PR #577): ordinary tool results survive in the ledger
 * only as 500-char previews placed BEFORE the requests that earned them, and
 * client-local results (list_context, evict_context) are deliberately not in
 * the ledger at all — so a two-iteration turn lost the first iteration's
 * results while the note claimed they followed. Replaying the ordered
 * dialogue is what keeps the reseeded session from re-issuing calls that
 * already ran (#572). Imitated frames are already cut by the host.
 */
/** The provider-session argument a continuation spawn carries, plus whether media is (re)delivered. */
export interface ContinuationSpawnArgs {
  sessionArgs: { backendSessionId?: string; backendSessionSeedId?: string };
  deliverMedia: boolean;
}

/**
 * What the continuation spawn must say about its session, from the decision:
 * a resume carries `backendSessionId`; a mid-turn SEED carries
 * `backendSessionSeedId` and re-delivers the turn's media (the fresh native
 * session has never seen it); a stateless spawn carries neither. Kept apart
 * from the request builder so the call path can be tested — the builder once
 * derived the argument from the live id and sent a freshly minted seed as a
 * resume of a session that did not exist (Lumen, PR #577 final pass).
 */
export function continuationSpawnArgs(
  decision: ReturnType<typeof decideContinuationSession>,
  hasMedia: boolean
): ContinuationSpawnArgs {
  if (decision.mode === 'resume')
    return { sessionArgs: { backendSessionId: decision.id }, deliverMedia: false };
  if (decision.mode === 'seed')
    return { sessionArgs: { backendSessionSeedId: decision.id }, deliverMedia: hasMedia };
  return { sessionArgs: {}, deliverMedia: false };
}

export function buildMidTurnReseedBody(
  dialogue: readonly ReseedDialogueEntry[],
  options: { protectedTail?: number; stateless?: boolean } = {}
): string {
  const rendered = dialogue
    .map((entry) => {
      const text = entry.text.trim();
      if (!text) return undefined;
      const label =
        entry.role === 'assistant' ? 'YOU' : entry.role === 'user' ? 'USER' : 'INK RUNTIME';
      return { text: `${label}:\n${text}`, user: entry.role === 'user' };
    })
    .filter((entry): entry is { text: string; user: boolean } => entry !== undefined);
  if (rendered.length === 0) return '';
  // The LAST entry is the continuation the model is about to receive — the
  // real tool results of the iteration that just ran. It is never cut: a
  // budget applied to the joined text sliced through it and silently dropped
  // results and role framing (Lumen, PR #577 round 2). The budget applies to
  // the dialogue BEFORE it, whole entries from the most recent backwards;
  // what does not fit is elided, and the elision says how much.
  // The latest result and newly inserted user messages are one protected
  // boundary. Earlier steering stays user-attributed even when older tool
  // dialogue is elided. Admission bounds its cumulative size per owner.
  const tailSize = Math.max(1, options.protectedTail ?? 1);
  const last = rendered
    .slice(-tailSize)
    .map((entry) => entry.text)
    .join('\n\n');
  const earlier = rendered.slice(0, -tailSize);
  let budget = MID_TURN_RESEED_MAX_CHARS - last.length;
  const kept: string[] = [];
  let eliding = false;
  for (let i = earlier.length - 1; i >= 0; i -= 1) {
    const entry = earlier[i]!;
    if (!entry.user && (eliding || entry.text.length + 2 > budget)) {
      eliding = true;
      continue;
    }
    kept.unshift(entry.text);
    budget -= entry.text.length + 2;
  }
  const elided = earlier.length - kept.length;
  const shown = [
    ...(elided > 0
      ? [`…[earlier turn dialogue elided: ${elided} ${elided === 1 ? 'entry' : 'entries'}]`]
      : []),
    ...kept,
    last,
  ].join('\n\n');
  return [
    '[This turn so far]',
    `${options.stateless ? 'This stateless request carries the current turn dialogue.' : 'The provider session was re-seeded mid-turn after a context change on the ink side.'} This is the turn up to this point: what you wrote, what the ink runtime sent back, and any subsequent user messages. The ink-tool blocks in your own output were already executed and their results appear below in order — do not repeat those calls. Continue from the end of it.`,
    '---',
    shown,
    '---',
  ].join('\n');
}

/**
 * What this spawn has said, as the reseed dialogue records it: everything up
 * to the frame the guard found, or everything so far. Called on every block
 * with the spawn's UNCUT text, so a frame confirmed in block N retracts what
 * block N-1 had recorded (`Looking.\nuser` becomes `Looking.\n`).
 */
export function spawnDialogueText(
  spawnSaid: string,
  guarded: { imitationDiscarded: boolean; frameIndex?: number }
): string {
  return guarded.imitationDiscarded ? spawnSaid.slice(0, guarded.frameIndex ?? 0) : spawnSaid;
}

/**
 * The occupancy a turn reasons with — for the hooks that gate on it and for
 * the stamp the agent reads.
 *
 * This was `ledger.totalTokens() / (maxContextTokens - bootstrapReserve)` at
 * both fire sites: the ledger estimate, which is the number task 480b76f7
 * exists to stop us acting on. Measured on myra session 64e1eb49 the estimate
 * read 131,071 against a provider measurement of 383,046 — so a monitor armed
 * at 80% would not have fired until the real window was long past full, and
 * the passive-recall ceiling that suppresses injection above 80% was reading
 * the same wrong number. Both behaviours were calibrated against a figure
 * roughly 2.9x below the truth.
 *
 * Exported so the wiring is testable without standing up a turn: a test that
 * only checks the hook's reaction to a supplied utilization cannot see which
 * number the caller computed.
 */
export function turnContextOccupancy(
  ledger: ContextLedger,
  runtime: SessionPromptState,
  measured: ProviderContextMeasurement | undefined
): ContextOccupancy {
  return computeContextOccupancy(
    ledger.totalTokens(),
    runtime.bootstrapContext ? estimateTokens(runtime.bootstrapContext) : 0,
    runtime.maxContextTokens,
    measured
  );
}

/**
 * The turn body sent to a RESUMED native session: the delta only, because the
 * session already holds the history.
 *
 * Extracted so the stamp's presence on this path is testable. The envelope path
 * is the easy one to get right and the easy one to test; this is the path a
 * long-running bridge session actually takes, turn after turn, and the seat
 * where nobody is watching (task 480b76f7, acceptance 1).
 */
export function buildDeltaPrompt(
  contextStamp: string | undefined,
  recallDelta: string,
  userMessage: string
): string {
  return [contextStamp, recallDelta, userMessage].filter(Boolean).join('\n\n');
}

/**
 * The body of a TOOL-LOOP CONTINUATION, for each of the three ways one reaches
 * the provider.
 *
 * All three carried no stamp at all until Lumen's #639 review: `resume` sent
 * the bare tool result, and `seed`/`stateless` called buildPromptEnvelope
 * without its stamp argument. That left the stamp on the outer opening only —
 * which is the one request per turn where it is LEAST informative. The provider
 * measurement for a turn is sampled from each spawn's usage AFTER that spawn
 * returns, so a fresh run's opening stamp has no measurement to report
 * (`splitKnown: false`); by the first continuation there is one. A headless run
 * that does all its work inside one turn's tool loop could therefore finish
 * without ever seeing a provider-backed reading of its own window.
 *
 * So the caller regenerates the stamp per continuation rather than threading
 * the opening's down: a stamp recomputed after the last spawn is the point of
 * the thing, and a stale one is what the envelope path already taught us to
 * avoid.
 *
 * Extracted and pure for the same reason buildDeltaPrompt is — the wiring is
 * the part that was wrong, and a test of the selection logic has to be able to
 * reach it without standing up a backend.
 */
export function buildContinuationPrompt(
  mode: 'resume' | 'seed' | 'stateless',
  contextStamp: string | undefined,
  body: string,
  renderEnvelope: (promptBody: string, stamp: string | undefined) => string,
  renderReseedBody: () => string
): string {
  if (mode === 'resume') {
    // The live session already holds the transcript; the stamp is the only
    // thing it cannot have, since it describes the window as of right now.
    return buildDeltaPrompt(contextStamp, '', body);
  }
  return renderEnvelope(mode === 'seed' ? renderReseedBody() : body, contextStamp);
}

export function buildSessionPrompt(
  sbSlug: string,
  runtime: SessionPromptState,
  ledger: ContextLedger,
  userMessage: string,
  localToolInstruction: string,
  /**
   * Rendered immediately before the latest user message so it is the freshest
   * thing in the envelope. Deliberately NOT part of envelopeShapeKey — it
   * changes every turn, and treating it as envelope shape would invalidate and
   * reseed the native session on each one.
   */
  contextStamp?: string,
  excludeEids?: ReadonlySet<number>
): string {
  // Reserve bootstrap context budget (not counted against transcript budget)
  const bootstrapTokens = runtime.bootstrapContext ? estimateTokens(runtime.bootstrapContext) : 0;
  const transcriptBudget = Math.max(0, runtime.maxContextTokens - bootstrapTokens);

  const transcript = ledger.buildPromptTranscript({
    maxTokens: transcriptBudget,
    includeSources: true,
    excludeEids,
  });

  const toolInstruction =
    runtime.toolRouting === 'local'
      ? localToolInstruction
      : runtime.toolMode === 'off'
        ? 'Do not call backend-native tools. Provide reasoning and instructions only.'
        : runtime.toolMode === 'privileged'
          ? 'Backend-native tools are enabled and external actions are allowed when needed.'
          : '';

  return [
    // A caller-supplied system prompt is the only thing allowed to say who
    // this is. `ink awaken` runs under the placeholder agent id `nascent`;
    // asserting "You are nascent." here would contradict the system prompt
    // that is, at that moment, telling them they do not have a name yet.
    runtime.systemPromptOverride ? '' : `You are ${sbSlug}.`,
    'You are running inside ink chat (first-class Ink REPL).',
    'Answer in plain text. Be concise but complete.',
    `Current backend: ${runtime.backend}${runtime.model ? ` (${runtime.model})` : ''}.`,
    `Tool mode: ${runtime.toolMode}.`,
    `Tool routing: ${runtime.toolRouting}.`,
    runtime.strictTools ? 'Strict tools mode: ON.' : '',
    toolInstruction,
    runtime.activeSkills.length > 0
      ? `Active skills: ${runtime.activeSkills.map((skill) => skill.name).join(', ')}`
      : '',
    runtime.threadKey ? `Thread key: ${runtime.threadKey}.` : '',
    // Identity context from bootstrap — always included
    runtime.bootstrapContext
      ? `\n=== Identity Context (from Inkwell bootstrap) ===\n${runtime.bootstrapContext}\n=== End Identity Context ===`
      : '',
    '',
    'Conversation transcript:',
    transcript || '(empty)',
    runtime.activeSkills.length > 0
      ? `\nSkill instructions:${renderActiveSkills(runtime.activeSkills)}`
      : '',
    '',
    contextStamp ?? '',
    'Latest user message:',
    userMessage,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * A stable signature of everything buildPromptEnvelope renders that does NOT
 * change per turn — the static "shape" a seeded provider session already holds:
 * system framing, tool instructions (from tool mode/routing), strict flag,
 * skills, thread key, and identity context. Excludes the transcript/recall/raw,
 * which ARE the intended per-turn delta. When this drifts mid-session — /backend,
 * /model, /tool-routing, /skill-use, /skill-clear, /refresh, profile changes —
 * the resumed native session would be stale (e.g. seeded with backend
 * tool-routing, then /tool-routing local leaves it without ink-tool
 * instructions), so runUserTurn invalidates and reseeds. Subsumes the backend
 * check (backend is part of the shape). Hashed so the stored key stays small.
 * Keep this in sync with buildPromptEnvelope's static (non-transcript) fields.
 */
export function envelopeShapeKey(runtime: SessionPromptState): string {
  const shape = [
    runtime.backend,
    runtime.model ?? '',
    // The packing budget: a session seeded under a smaller budget holds only
    // that slice of history. When model detection RAISES the budget
    // (170K → 850K), delta turns can never retrofit the omitted older history
    // into the live session — the drift this causes here makes the next turn
    // reseed with the wider envelope (Lumen, PR #477 round 2 — finding 1).
    String(runtime.maxContextTokens),
    runtime.toolMode,
    runtime.toolRouting,
    runtime.strictTools ? '1' : '0',
    runtime.threadKey ?? '',
    runtime.activeSkills.map((s) => s.name).join(','),
    runtime.bootstrapContext ?? '',
    // Gates the "You are <sbSlug>." line. Fixed for the session's lifetime
    // (set from --system-prompt-file at startup, never mutated), so it cannot
    // actually drift — included to keep this in sync with every static field
    // buildPromptEnvelope renders, as the contract above requires.
    runtime.systemPromptOverride ? '1' : '0',
  ].join('');
  // djb2 — cheap, kept in int32 each step; collision-resistant enough to detect
  // config drift (we only need change-detection, not cryptographic strength).
  let hash = 5381;
  for (let i = 0; i < shape.length; i++) {
    hash = ((hash << 5) + hash + shape.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
