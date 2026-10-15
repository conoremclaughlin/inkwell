import type { ToolAttemptOwner } from './tool-invocation-journal.js';

/** Tool-resource/recovery obligations, not effect certainty or provider-process lifetime. */
export interface ToolSettlementSnapshot {
  owner: ToolAttemptOwner;
  admission: 'open' | 'closed';
  generationEnded: boolean;
  stopRequested: boolean;
  stopFailed: boolean;
  waitExpired: boolean;
  resources: 'live' | 'settled' | 'reconciliation-required';
}

const ownerKey = (owner: ToolAttemptOwner) =>
  JSON.stringify([owner.sessionId, owner.turnId, owner.attemptId]);

function deadline(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 2_147_483_647)
    throw new Error('Invalid tool settlement deadline');
}

/**
 * One host-owned registry per session. It holds actual settlement promises,
 * never executable recovery work. A bounded observer does not detach an effect
 * or release its resources. A settled dispatcher error is not a live resource:
 * its unknown effect remains in the journal, separately from this registry.
 *
 * This does not kill processes, bound execution, or make a host drain ready by
 * itself. Provider children have their own owner. Hosts must compose both and
 * supply confirmed cancellation/cleanup before enabling production streaming.
 */
export class ToolSettlementSupervisor {
  readonly sessionId: string;
  private readonly maxActiveAttempts: number;
  private readonly active = new Map<string, ToolSettlementLease>();
  private closed = false;

  constructor(options: { sessionId: string; maxActiveAttempts: number }) {
    if (
      !options.sessionId ||
      !Number.isSafeInteger(options.maxActiveAttempts) ||
      options.maxActiveAttempts < 1
    )
      throw new Error('Invalid tool settlement supervisor bounds');
    this.sessionId = options.sessionId;
    this.maxActiveAttempts = options.maxActiveAttempts;
  }

  /** Fresh copies only: drain can observe the canonical owner, not mutate it. */
  observe(): ToolSettlementSnapshot[] {
    return [...this.active.values()].map((lease) => lease.observe());
  }

  /** Also reaches an opening failure whose stream never returned its lease. */
  reconcile(owner: ToolAttemptOwner, confirmReconciled: () => Promise<boolean>): Promise<boolean> {
    const lease = this.active.get(ownerKey(owner));
    if (!lease) return Promise.reject(new Error('Tool settlement owner is not registered'));
    return lease.reconcile(confirmReconciled);
  }

  track(
    owner: ToolAttemptOwner,
    ports: {
      /** Resolves after work ends with persistence/release confirmed; rejects for reconciliation. */
      settled: Promise<void>;
      /** Synchronous signal/close request, not a second background operation. */
      requestStop(): undefined;
    }
  ): ToolSettlementLease {
    if (owner.sessionId !== this.sessionId || !owner.turnId || !owner.attemptId)
      throw new Error('Tool settlement owner does not match its session');
    if (this.closed) throw new Error('Tool settlement supervisor is closing');
    const key = ownerKey(owner);
    if (this.active.has(key)) throw new Error('Tool settlement owner is already live');
    if (this.active.size >= this.maxActiveAttempts)
      throw new Error('Tool settlement owner capacity reached');
    const lease = new ToolSettlementLease(owner, ports, () => {
      // A late callback may only remove its own reservation.
      if (this.active.get(key) === lease) this.active.delete(key);
    });
    this.active.set(key, lease);
    return lease;
  }

  /** Fence new owners synchronously, request Stop, then observe for one bound. */
  async stopAndWait(timeoutMs: number): Promise<ToolSettlementSnapshot[]> {
    deadline(timeoutMs);
    this.closed = true;
    const owners = [...this.active.values()];
    for (const owner of owners) owner.requestStop();
    await Promise.all(owners.map((owner) => owner.wait(timeoutMs)));
    return this.observe();
  }
}

export class ToolSettlementLease {
  private readonly state: ToolSettlementSnapshot;
  private readonly observed: Promise<void>;
  private reconciling: Promise<boolean> | undefined;

  constructor(
    owner: ToolAttemptOwner,
    private readonly ports: { settled: Promise<void>; requestStop(): undefined },
    private readonly release: () => void
  ) {
    this.state = {
      owner: { ...owner },
      admission: 'open',
      generationEnded: false,
      stopRequested: false,
      stopFailed: false,
      waitExpired: false,
      resources: 'live',
    };
    // Observe rejection immediately. Failed persistence or cleanup is not
    // proof of release; retain the owner for explicit host reconciliation.
    this.observed = ports.settled.then(
      () => this.settled(),
      () => {
        this.closeAdmission();
        this.state.resources = 'reconciliation-required';
      }
    );
  }

  observe(): ToolSettlementSnapshot {
    return { ...this.state, owner: { ...this.state.owner } };
  }

  closeAdmission(): void {
    this.state.admission = 'closed';
  }
  markGenerationEnded(): void {
    this.state.generationEnded = true;
  }

  requestStop(): void {
    if (this.state.stopRequested || this.state.resources === 'settled') return;
    this.state.stopRequested = true;
    this.closeAdmission();
    try {
      this.ports.requestStop();
    } catch {
      this.state.stopFailed = true;
    }
  }

  /** A deadline is an observation, not a synthetic tool outcome or a release. */
  async wait(timeoutMs: number): Promise<ToolSettlementSnapshot> {
    deadline(timeoutMs);
    if (this.state.resources !== 'live') return this.observe();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.observed,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (this.state.resources === 'live') this.state.waitExpired = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
      return this.observe();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Confirm recovery AND cleanup obligations; a live effect cannot be waived. */
  reconcile(confirmReconciled: () => Promise<boolean>): Promise<boolean> {
    if (this.state.resources !== 'reconciliation-required')
      return Promise.reject(new Error('Tool resources do not require reconciliation'));
    return (this.reconciling ??= (async () => {
      await Promise.resolve(); // Install the shared promise before a port can throw.
      try {
        if (!(await confirmReconciled())) return false;
        this.settled();
        return true;
      } catch {
        return false;
      } finally {
        this.reconciling = undefined;
      }
    })());
  }

  private settled(): void {
    this.state.resources = 'settled';
    this.closeAdmission();
    this.release();
  }
}
