import type { BackendModelUsage, BackendTokenUsage } from './token-usage.js';

// Totals for THIS process, summed across every backend invocation it makes.
// One ink run invokes the provider repeatedly — once per outer turn (server
// default maxTurns=5) and again for each tool-loop continuation — so the last
// result covers only the final invocation. Reporting that as the run's usage
// undercounts every invocation but the last (Lumen, PR #494 round 2).
export class SessionUsage {
  readonly totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  // Called at every backend result inside runTurnForLoop — the single boundary
  // all invocations flow through since the runAgentLoop extraction (#489).
  // A failed attempt that still reported usage counts: those tokens were spent.
  //
  // SUMMED, not diffed — and that is a deliberate, verified choice. Reading the
  // Claude Code 2.1.233 binary suggests otherwise: its resume path can restore
  // `lastModelUsage` into the cost ledger, and the result builder serializes
  // `usage`/`modelUsage` from that ledger, which reads like every result is a
  // running total that must be checkpointed and diffed.
  //
  // It is not, on this path. The save-on-exit that would populate that ledger
  // is installed by the interactive React cost/status hook, and `-p` never
  // mounts it — so a print-mode resume has nothing to restore. Confirmed
  // black-box on 2.1.233 with three sequential `-p --resume` turns: costs came
  // back $0.0176 / $0.0030 / $0.0029, each its own invocation, and the session
  // transcript contained neither `modelUsage` nor `lastModelUsage`.
  //
  // This is provider-version behavior, not a contract. If a future version
  // starts emitting running totals here, the symptom is session costs and
  // tokens growing quadratically — at which point this needs per-native-session
  // checkpoint/diff, the way SessionRepository.updateTokenUsage already does
  // for Codex. (Wren's experiment + Lumen's binary analysis, PR #500.)
  // Per-model totals for this run, accumulated key by key exactly as the
  // backend reported them. Carries the backend's own costUSD, which is what
  // makes spend answerable in dollars without a price table on our side.
  readonly models: Record<string, BackendModelUsage> = {};

  record(usage: BackendTokenUsage | undefined): void {
    if (!usage) return;
    this.totals.inputTokens += usage.inputTokens || 0;
    this.totals.outputTokens += usage.outputTokens || 0;
    this.totals.cacheReadTokens += usage.cacheReadTokens || 0;
    this.totals.cacheWriteTokens += usage.cacheWriteTokens || 0;
    for (const [model, entry] of Object.entries(usage.modelUsage || {})) {
      const prior = this.models[model];
      this.models[model] = {
        inputTokens: (prior?.inputTokens || 0) + entry.inputTokens,
        outputTokens: (prior?.outputTokens || 0) + entry.outputTokens,
        cacheReadTokens: (prior?.cacheReadTokens || 0) + entry.cacheReadTokens,
        cacheWriteTokens: (prior?.cacheWriteTokens || 0) + entry.cacheWriteTokens,
        // Cost completeness, not just cost. Summing only the known parts and
        // publishing the subtotal as the total under-reports invisibly; a
        // first contribution that reports cost starts complete, and any
        // unknown contribution after that marks the running figure partial.
        ...(() => {
          const priorCost = prior?.costUSD;
          const entryCost = entry.costUSD;
          if (priorCost === undefined && entryCost === undefined) return {};
          const partial =
            prior?.costPartial === true ||
            (prior !== undefined && priorCost === undefined) ||
            entryCost === undefined;
          return {
            costUSD: (priorCost ?? 0) + (entryCost ?? 0),
            ...(partial ? { costPartial: true } : {}),
          };
        })(),
        ...(entry.canonicalModel ? { canonicalModel: entry.canonicalModel } : {}),
      };
    }
  }
}
