/** The existing parent turn: provider continuity plus Ink's tool loop, not a second loop. */
import {
  relayBudgetBytes,
  MIN_RELAY_BUDGET_BYTES,
  MAX_STEERING_RECEIPTS,
  runAgentLoop,
  type AgentLoopPorts,
  type PreparedSessionTurn,
} from '../runtime/index.js';
import { createSessionProviderTurn, type SessionProviderPorts } from './session-provider.js';
import type { TurnMedia } from './types.js';

export interface SessionAgentTurnPorts extends Omit<AgentLoopPorts, 'backend'> {
  provider: SessionProviderPorts;
  /** Close mid-turn admission before the enclosing outcome commit or hook. */
  finishSteering?(): Promise<void>;
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
  let providerTurn: ReturnType<typeof createSessionProviderTurn> | undefined;
  const invalidateSteeredHistory = async () => {
    if (!providerTurn?.steeringDeliveryUncertain || !ports.provider.state.id) return;
    try {
      ports.rollProviderSession(
        'steering-delivery-uncertain',
        'Committed user steering will be reconstructed on the next ordinary turn.'
      );
      await ports.provider.flush();
    } finally {
      // Even if persistence itself fails, this instance must not reuse the
      // opaque provider history. No failed turn is automatically retried.
      ports.provider.state.id = undefined;
      ports.provider.state.shape = undefined;
    }
  };
  try {
    input.signal?.throwIfAborted();
    providerTurn = createSessionProviderTurn(
      ports.provider,
      input.raw,
      input.turnMedia,
      input.prepared
    );
    const currentProviderTurn = providerTurn;
    const loop = await runAgentLoop(
      {
        prompt: providerTurn.prompt,
        toolRouting: ports.provider.runtime.toolRouting,
        signal: input.signal,
        relayBudgetBytes: () => {
          const pending = ports.provider.steering?.pendingTextBytes?.() ?? 0;
          // Body construction and drain's snapshot run synchronously back to
          // back; later arrivals wait for another boundary. Reserve UTF-8
          // bytes plus worst-case USER labels before truncating tool results.
          // The existing diagnostic floor still applies: exhausted headroom
          // can overrun by that floor plus the admission-bounded user input.
          const reserve = pending > 0 ? pending + 8 * MAX_STEERING_RECEIPTS : 0;
          return Math.max(
            MIN_RELAY_BUDGET_BYTES,
            relayBudgetBytes(ports.provider.runtime, currentProviderTurn.relayOccupancy()) - reserve
          );
        },
        continueOnFailure: input.continueOnFailure,
      },
      {
        ui: ports.ui,
        tools: ports.tools,
        observe: ports.observe,
        backend: { runTurn: providerTurn.runTurn },
      }
    );
    if (!loop.success) await invalidateSteeredHistory();
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
  } catch (error) {
    try {
      await invalidateSteeredHistory();
    } catch {
      // Preserve the original provider/dispatch failure if logging also fails.
    }
    throw error;
  } finally {
    await ports.finishSteering?.();
  }
}
