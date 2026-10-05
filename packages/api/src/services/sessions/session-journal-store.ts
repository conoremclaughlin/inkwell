import type { SupabaseClient } from '@supabase/supabase-js';
import {
  canonicalJournalJson,
  freezeJournalEntry,
  type JournalAppendRequest,
  type JournalHoldRequest,
  type JournalIdentity,
  type JournalStore,
} from '@inklabs/shared/runtime';
import { ADMISSION_PROTOCOL } from './command-admission';
import { tenureCapabilityHash } from './tenure-admission';

export class SessionJournalStoreError extends Error {
  constructor(readonly code: 'invalid_request' | 'transport_failed' | 'invalid_reply') {
    // Never include an RPC error, credential, request or returned payload here.
    super(`Session journal store: ${code}`);
    this.name = 'SessionJournalStoreError';
  }
}

const HOLD_REASONS = [
  'invalid_entry',
  'entry_too_large',
  'queue_capacity',
  'eid_exhausted',
  'append_failed',
  'invalid_receipt',
  'store_refused',
  'projection_held',
  'head_advanced',
] as const;

/**
 * Host-only D1 store. DARK: no live caller. The caller supplies its stateless
 * service client and the holder capability, never an agent/tool-supplied one.
 * That client must use persistSession:false and autoRefreshToken:false and must
 * not be shared with auth.* callers. Its credential is not frozen by this port.
 * The submitted hash is bearer-equivalent in A2, not safe diagnostic data.
 *
 * Before live wiring the host must bound/abort RPC transport; this adapter has
 * no intrinsic timeout. A hung call remains unknown, not not-spawned. Expiry
 * must stop dispatch without claiming rollback or releasing authority.
 *
 * Use through JournalWriter: this port bounds/detaches transport data but does
 * not turn a reply into a verified commit receipt or execution permission.
 * The database authenticates the current holder, orders locks and commits the
 * entry, invocation projection and cursor atomically. There is no second
 * projection request, automatic retry, fallback, or implicit journal creation.
 */
export class SessionJournalStore implements JournalStore {
  readonly #client: SupabaseClient;
  readonly #identity: Readonly<JournalIdentity>;
  readonly #capabilityHash: string;
  readonly #maxEntryBytes: number;

  constructor(options: {
    client: SupabaseClient;
    identity: JournalIdentity;
    capability: string;
    maxEntryBytes: number;
  }) {
    try {
      if (
        !options.client ||
        typeof options.client.rpc !== 'function' ||
        typeof options.capability !== 'string' ||
        options.capability.length < 1 ||
        options.capability.length > 4096 ||
        !Number.isSafeInteger(options.maxEntryBytes) ||
        options.maxEntryBytes < 1 ||
        options.maxEntryBytes > 256 * 1024
      )
        throw new Error();
      const identity = JSON.parse(canonicalJournalJson(options.identity, 2048)) as JournalIdentity;
      if (
        Object.keys(identity).sort().join(',') !==
        'hostInstanceId,journalId,sessionId,writerTenureId'
      )
        throw new Error();
      // Reuse the shared identity grammar instead of maintaining a second one.
      freezeJournalEntry(
        {
          ...identity,
          version: 1,
          eid: 1,
          ts: '2000-01-01T00:00:00.000Z',
          type: 'session_open',
          target: null,
          body: {},
        },
        4096
      );
      this.#identity = Object.freeze(identity);
      this.#capabilityHash = tenureCapabilityHash(options.capability);
      this.#client = options.client;
      this.#maxEntryBytes = options.maxEntryBytes;
    } catch {
      throw new SessionJournalStoreError('invalid_request');
    }
  }

  async append(request: JournalAppendRequest): Promise<unknown> {
    let snapshot: ReturnType<typeof freezeJournalEntry>;
    let expectedCommittedEid: number;
    try {
      const input = JSON.parse(
        canonicalJournalJson(request, this.#maxEntryBytes + 128)
      ) as JournalAppendRequest;
      if (Object.keys(input).sort().join(',') !== 'entry,expectedCommittedEid') throw new Error();
      snapshot = freezeJournalEntry(input.entry, this.#maxEntryBytes);
      expectedCommittedEid = input.expectedCommittedEid;
      if (
        !this.matches(snapshot.entry) ||
        !Number.isSafeInteger(expectedCommittedEid) ||
        expectedCommittedEid < 0 ||
        snapshot.entry.eid - 1 !== expectedCommittedEid
      )
        throw new Error();
    } catch {
      throw new SessionJournalStoreError('invalid_request');
    }
    return this.call(
      'append_session_journal',
      {
        ...this.authority(),
        p_expected_committed_eid: expectedCommittedEid,
        p_entry: snapshot.entry,
      },
      this.#maxEntryBytes + 2048
    );
  }

  async hold(request: Readonly<JournalHoldRequest>): Promise<unknown> {
    let input: JournalHoldRequest;
    try {
      input = JSON.parse(canonicalJournalJson(request, 2048)) as JournalHoldRequest;
      if (
        Object.keys(input).sort().join(',') !==
          'hostInstanceId,journalId,reasonCode,sessionId,writerTenureId' ||
        !this.matches(input) ||
        !HOLD_REASONS.includes(input.reasonCode)
      )
        throw new Error();
    } catch {
      throw new SessionJournalStoreError('invalid_request');
    }
    return this.call(
      'hold_session_journal',
      {
        ...this.authority(),
        p_reason_code: input.reasonCode,
      },
      2048
    );
  }

  private matches(identity: JournalIdentity): boolean {
    return (
      identity.journalId === this.#identity.journalId &&
      identity.sessionId === this.#identity.sessionId &&
      identity.writerTenureId === this.#identity.writerTenureId &&
      identity.hostInstanceId === this.#identity.hostInstanceId
    );
  }

  private authority(): Record<string, unknown> {
    return {
      p_session_id: this.#identity.sessionId,
      p_tenure_id: this.#identity.writerTenureId,
      p_host_instance_id: this.#identity.hostInstanceId,
      p_journal_id: this.#identity.journalId,
      p_capability_hash: this.#capabilityHash,
      p_protocol: ADMISSION_PROTOCOL,
    };
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
    maxReplyBytes: number
  ): Promise<unknown> {
    let data: unknown;
    try {
      const result = await this.#client.rpc(name, args);
      if (result.error) throw new Error();
      data = result.data;
    } catch {
      // The request might have committed. No retry, no fabricated refusal, no
      // error cause containing PostgREST details or a caller's credentials.
      throw new SessionJournalStoreError('transport_failed');
    }
    try {
      // JournalWriter separately verifies the complete expected echo and the
      // projection. A bounded malformed reply is not normalized into success.
      return JSON.parse(canonicalJournalJson(data, maxReplyBytes)) as unknown;
    } catch {
      throw new SessionJournalStoreError('invalid_reply');
    }
  }
}
