/**
 * spawn_agent — the shadow-clone tool
 *
 * Lets an SB in the ink runtime fork *itself* for bounded work: same identity,
 * blank conversational slate, a summary handed back. The parent's ledger gains
 * one entry for the whole fan-out rather than every intermediate result, which
 * is the context-isolation win the whole feature exists for.
 *
 * This module owns the pure parts — argument validation, the exclusivity rule,
 * summary bounding — so they can be tested without a backend. The fan-out itself
 * lives in the host, which is the only place that knows how to spawn a backend.
 *
 * See `ink://specs/ink-runtime-shadow-clones`, Q3–Q5.
 */

import type { LocalToolCall } from './agent-loop.js';

export const SPAWN_AGENT_TOOL = 'spawn_agent';

/** Read back what backgrounded clones produced. */
export const COLLECT_AGENTS_TOOL = 'collect_agents';

/** Ceiling on one fan-out. Concurrency the user can actually follow. */
export const MAX_CLONES_PER_SPAWN = 3;

/** Longest summary a clone may push into the parent's ledger. */
export const MAX_CLONE_SUMMARY_CHARS = 4000;

export interface SpawnAgentTask {
  label: string;
  prompt: string;
}

export interface SpawnAgentRequest {
  tasks: SpawnAgentTask[];
  /**
   * When false, the tool returns clone handles immediately and the clones keep
   * running in the background. The parent collects them later, or navigates to
   * them in the TUI. Defaults to true — awaiting is the simple, obvious case.
   */
  wait: boolean;
}

export type SpawnAgentParse =
  | { ok: true; request: SpawnAgentRequest }
  | { ok: false; error: string };

export function parseSpawnAgentArgs(args: Record<string, unknown>): SpawnAgentParse {
  const rawTasks = args.tasks;
  if (!Array.isArray(rawTasks)) {
    return { ok: false, error: 'spawn_agent requires a "tasks" array.' };
  }
  if (rawTasks.length === 0) {
    return { ok: false, error: 'spawn_agent requires at least one task.' };
  }
  if (rawTasks.length > MAX_CLONES_PER_SPAWN) {
    return {
      ok: false,
      error: `spawn_agent accepts at most ${MAX_CLONES_PER_SPAWN} tasks; got ${rawTasks.length}.`,
    };
  }

  const tasks: SpawnAgentTask[] = [];
  for (const [index, raw] of rawTasks.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `Task ${index + 1} must be an object with label and prompt.` };
    }
    const entry = raw as Record<string, unknown>;
    const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
    if (!prompt) {
      return { ok: false, error: `Task ${index + 1} is missing a non-empty "prompt".` };
    }
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    tasks.push({ label: label || `task ${index + 1}`, prompt });
  }

  return { ok: true, request: { tasks, wait: args.wait !== false } };
}

export type IterationScreen =
  | { ok: true; calls: LocalToolCall[]; spawn?: LocalToolCall }
  | { ok: false; reason: string };

/**
 * Decide what an iteration is allowed to run.
 *
 * `spawn_agent` must be the ONLY call in its iteration. Two reasons, and the
 * second is why this runs over the FULL extracted list rather than the truncated
 * one:
 *
 * 1. A fan-out changes what the parent's context contains, so mixing it with
 *    ordinary calls makes the ordering of side effects unreadable.
 * 2. If exclusivity were checked after truncation, a spawn in sixth position
 *    would be silently dropped by the per-iteration cap and never noticed.
 *
 * A mixed iteration is refused WHOLE. Quietly picking the spawn — or quietly
 * dropping it and running its siblings — leaves the model believing calls may
 * have run, which invites confused retries against half-applied state.
 */
export function screenIteration(
  allCalls: readonly LocalToolCall[],
  maxCallsPerIteration: number
): IterationScreen {
  const spawns = allCalls.filter((c) => normalizeToolName(c.tool) === SPAWN_AGENT_TOOL);

  if (spawns.length === 0) {
    return { ok: true, calls: allCalls.slice(0, maxCallsPerIteration) };
  }

  if (spawns.length > 1) {
    return {
      ok: false,
      reason: `${SPAWN_AGENT_TOOL} may appear at most once per turn; found ${spawns.length}. No calls were executed — re-emit a single ${SPAWN_AGENT_TOOL} block carrying every task.`,
    };
  }

  if (allCalls.length > 1) {
    const others = allCalls
      .filter((c) => normalizeToolName(c.tool) !== SPAWN_AGENT_TOOL)
      .map((c) => c.tool);
    return {
      ok: false,
      reason: `${SPAWN_AGENT_TOOL} must be the only tool call in its turn, but it was emitted alongside: ${others.join(', ')}. No calls were executed — either spawn alone, or run the other tools first.`,
    };
  }

  return { ok: true, calls: [spawns[0]], spawn: spawns[0] };
}

function normalizeToolName(tool: string): string {
  return tool.trim().replace(/^mcp__inkwell__/, '');
}

/**
 * The prompt a clone wakes up with.
 *
 * A clone is the same SB with a blank conversational slate, so it needs to be
 * told three things its parent never has to say aloud: what it is, that its
 * final message IS the deliverable, and that it cannot delegate further.
 */
export function buildClonePrompt(
  task: SpawnAgentTask,
  ctx: { id: string; total: number; index: number }
): string {
  return [
    `You are a shadow clone of yourself — the same identity, forked for one bounded task, with no memory of the conversation that spawned you.`,
    `Clone ${ctx.index + 1} of ${ctx.total} (${ctx.id}). Task: ${task.label}`,
    '',
    task.prompt,
    '',
    '---',
    'How this works:',
    '- Your FINAL message is what your parent receives. Nothing else you say survives. Write it as a report, not as a chat reply.',
    '- Lead with the answer. Include specifics your parent cannot re-derive cheaply: file paths, line numbers, names, counts. Say plainly what you could not determine.',
    '- You have read-oriented tools only. You cannot write files, run shell commands, send messages, save memories, or spawn further clones. Your parent handles all of that with what you hand back.',
    '- When you are done, emit signal_status with status "completed".',
  ].join('\n');
}

/**
 * Bound a clone's summary before it enters the parent's ledger.
 *
 * The parent pays context for whatever comes back, so an unbounded clone would
 * undo the isolation that justified spawning it.
 */
export function boundSummary(text: string, limit = MAX_CLONE_SUMMARY_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n…[truncated ${trimmed.length - limit} chars — full transcript on disk]`;
}

export interface CloneOutcomeSummary {
  id: string;
  label: string;
  status: string;
  summary?: string;
  error?: string;
  iterations?: number;
  stopReason?: string;
  transcriptPath?: string;
}

/**
 * Render the fan-out as ONE ledger entry.
 *
 * One entry per fan-out, not per clone: the parent asked one question and gets
 * one answer, however many clones served it.
 */
export function formatFanOutForLedger(outcomes: readonly CloneOutcomeSummary[]): string {
  const parts = outcomes.map((o) => {
    const head = `### ${o.id} · ${o.label} — ${o.status}`;
    if (o.error) return `${head}\n${o.error}`;
    return `${head}\n${o.summary?.trim() || '(no summary returned)'}`;
  });
  const failed = outcomes.filter((o) => o.error).length;
  const header = `🌀 ${outcomes.length} shadow clone(s) returned${failed > 0 ? ` (${failed} failed)` : ''}:`;
  return [header, ...parts].join('\n\n');
}
