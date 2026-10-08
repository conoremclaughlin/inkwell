/**
 * Two yardsticks for one window (Lumen, PR #583 finding 3).
 *
 * Ink's estimate covers the ledger — the transcript it packs — so it is judged
 * against the bootstrap-reduced allowance the ledger may occupy. The
 * provider's own count covers the whole request: identity envelope, bootstrap,
 * and whatever the native session accumulated that the ledger no longer holds
 * (evicted results, an earlier compaction the session outlived). That number is
 * judged against the full window.
 *
 * When only the provider's number is over, compacting the ledger destroys
 * history that is not the problem. The excess lives in the native session, so
 * the answer is to roll it: the next spawn seeds a fresh session from the
 * ledger. Without a native session there is nothing to roll and the ledger is
 * the only lever, so it compacts.
 */
export interface ContextPressureInput {
  /** ink's estimate of the ledger. */
  ledgerTokens: number;
  /** The ledger's allowance × the compaction share. */
  ledgerThreshold: number;
  /** The provider's count for the last request, when a scoped sample exists. */
  providerTokens?: number;
  /** The full window × the compaction share. */
  providerThreshold: number;
  /** A native provider session is live (resume mode). */
  hasProviderSession: boolean;
  format?: (tokens: number) => string;
}

export interface ContextPressure {
  action: 'none' | 'reseed' | 'compact';
  reason: string;
  ledgerOver: boolean;
  providerOver: boolean;
}

const defaultFormat = (n: number): string => n.toLocaleString('en-US');

export function assessContextPressure(input: ContextPressureInput): ContextPressure {
  const fmt = input.format ?? defaultFormat;
  const ledgerOver = input.ledgerTokens > input.ledgerThreshold;
  const providerOver =
    input.providerTokens !== undefined && input.providerTokens > input.providerThreshold;
  const ledgerReason = `ledger ~${fmt(input.ledgerTokens)} > ${fmt(input.ledgerThreshold)} allowance`;
  const providerReason = `provider measured ~${fmt(input.providerTokens ?? 0)} > ${fmt(input.providerThreshold)} of the window`;

  if (!ledgerOver && !providerOver) {
    return { action: 'none', reason: '', ledgerOver, providerOver };
  }
  if (ledgerOver) {
    return {
      action: 'compact',
      reason: providerOver ? `${ledgerReason}; ${providerReason}` : ledgerReason,
      ledgerOver,
      providerOver,
    };
  }
  if (input.hasProviderSession) {
    return {
      action: 'reseed',
      reason: `${providerReason} while the ledger is within its allowance — the excess is in the native session`,
      ledgerOver,
      providerOver,
    };
  }
  return {
    action: 'compact',
    reason: `${providerReason} with no native session to roll — the ledger is the only lever`,
    ledgerOver,
    providerOver,
  };
}
