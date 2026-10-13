/** Longest summary a clone may push into the parent's ledger. */
export const MAX_CLONE_SUMMARY_CHARS = 4000;

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
 * Which of these outcomes should enter the parent's ledger now.
 *
 * Two conditions, and both have bitten:
 *
 * - **Settled only.** An immediate `collect_agents` after `wait:false` returns
 *   `running` outcomes. Marking those seen would burn the clone's slot before it
 *   had a summary, so the completed result could never land at all.
 * - **Once each.** Polling a fan-out, or calling `collect_agents` again later,
 *   must not re-inject the same finished work into the parent's context.
 *
 * Mutates `alreadyLedgered` — a caller that asks is a caller that is about to
 * write, and splitting the two invites exactly the drift this replaced.
 */
export function selectOutcomesToLedger(
  outcomes: readonly CloneOutcomeSummary[],
  alreadyLedgered: Set<string>
): CloneOutcomeSummary[] {
  const fresh = outcomes.filter(
    (o) => o.status !== 'running' && o.status !== 'missing' && !alreadyLedgered.has(o.id)
  );
  for (const outcome of fresh) alreadyLedgered.add(outcome.id);
  return fresh;
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
