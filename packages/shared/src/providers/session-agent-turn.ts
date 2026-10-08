/** The existing parent turn: provider continuity plus Ink's tool loop, not a second loop. */
import {
  relayBudgetBytes,
  runAgentLoop,
  type AgentLoopPorts,
  type PreparedSessionTurn,
} from '../runtime/index.js';
import { createSessionProviderTurn, type SessionProviderPorts } from './session-provider.js';
import type { TurnMedia } from './types.js';

export interface SessionAgentTurnPorts extends Omit<AgentLoopPorts, 'backend'> {
  provider: SessionProviderPorts;
  /** Invalidate native history and persist the roll, as the CLI already does. */
  rollProviderSession(reason: string, detail: string): void;
}

/**
 * The enclosing coordinator owns recall, input/outcome commits and eviction.
 * Hosts supply the same policy-checked tool pipeline and streaming callbacks;
 * terminal signals, server admission and resource ownership stay with hosts.
 */
export async function runSessionAgentTurn(
  input: {
    raw: string;
    turnMedia: TurnMedia[];
    prepared: PreparedSessionTurn;
    signal?: AbortSignal;
    continueOnFailure: boolean;
  },
  ports: SessionAgentTurnPorts
) {
  input.signal?.throwIfAborted();
  const providerTurn = createSessionProviderTurn(
    ports.provider,
    input.raw,
    input.turnMedia,
    input.prepared
  );
  const loop = await runAgentLoop(
    {
      prompt: providerTurn.prompt,
      toolRouting: ports.provider.runtime.toolRouting,
      signal: input.signal,
      relayBudgetBytes: () =>
        relayBudgetBytes(ports.provider.runtime, providerTurn.relayOccupancy()),
      continueOnFailure: input.continueOnFailure,
    },
    {
      ui: ports.ui,
      tools: ports.tools,
      observe: ports.observe,
      backend: { runTurn: providerTurn.runTurn },
    }
  );
  // Never resume native history that still contains uncorrected fabricated
  // tool evidence. Only sanitized output enters the enclosing ledger.
  if (
    loop.protocolViolations.some((violation) => !violation.corrected) &&
    ports.provider.state.id
  ) {
    ports.rollProviderSession(
      'uncorrected-protocol-violation',
      'an imitated results frame went uncorrected'
    );
  }
  return { loop, backend: providerTurn.lastRunResult };
}
