/**
 * Owner tenure and turn generations (ink://specs/live-agent-surfaces v29
 * R1/R3), over the database functions in migration 20261004104039.
 *
 * A session has one authority row with two pointers: the tenure of the owner
 * allowed to advance it, and the turn it is running or last ran. An owner
 * registers a tenure, then admits, finishes and admits turns under it; a
 * finished turn leaves the tenure held, so no other writer gets in between.
 * Releasing the tenure needs every spawn resolved by evidence.
 *
 * The holder proves itself with a capability: a random secret minted here,
 * of which only the hash reaches the database. Knowing the tenure id is not
 * enough. Keep the secret out of reads, tools, journals, logs, provider
 * prompts and child environments; a file mode on disk is storage hygiene, not
 * a boundary against another process of the same OS user.
 *
 * DARK. Nothing in the server calls this yet, and every function refuses with
 * `mode_mismatch` until the database is in conditional mode. Parsing is
 * strict: a reply outside the contract throws.
 */

import { createHash, randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ADMISSION_PROTOCOL } from './command-admission';

export type TenureMode = 'server_hosted' | 'interactive_wrapper' | 'native_external';

/** What a holder presents. The secret is hashed here and never sent. */
export interface TenureHolder {
  tenureId: string;
  capability: string;
  hostInstanceId: string;
}

/** A fresh holder capability and the hash the database stores for it. */
export function mintTenureCapability(): { capability: string; capabilityHash: string } {
  const capability = randomBytes(32).toString('base64url');
  return { capability, capabilityHash: tenureCapabilityHash(capability) };
}

export function tenureCapabilityHash(capability: string): string {
  return `sha256:${createHash('sha256').update(capability).digest('hex')}`;
}

function parseReply<T>(schema: z.ZodType<T>, what: string, data: unknown, error: unknown): T {
  if (error) {
    const message =
      error instanceof Error ? error.message : (error as { message?: string }).message;
    throw new Error(`${what} failed: ${message ?? 'unknown error'}`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${what} returned a reply outside its contract`);
  return parsed.data;
}

const modeMismatch = z.object({
  outcome: z.literal('mode_mismatch'),
  mode: z.string().nullable(),
  protocol: z.number().int().nullable(),
});
const invalid = z.object({ outcome: z.literal('invalid'), field: z.string() });
const sessionMissing = z.object({ outcome: z.literal('session_missing') });
const notHolder = z.object({ outcome: z.literal('not_holder') });
const held = z.object({
  outcome: z.literal('held'),
  hold: z.enum(['recovery_required', 'unresolved_dispatch']),
  holdingCommand: z.string().uuid(),
});
const tenureState = z.enum(['held', 'released', 'recovery_required', 'reconciled']);

const registerSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('registered'), tenureId: z.string().uuid() }),
  z.object({ outcome: z.literal('occupied'), tenureId: z.string().uuid(), state: tenureState }),
  z.object({ outcome: z.literal('unverified') }),
  z.object({
    outcome: z.literal('stale_expectation'),
    tenureId: z.string().uuid().optional(),
    state: z.union([tenureState, z.literal('never_owned')]),
  }),
  z.object({ outcome: z.literal('unresolved'), tenureId: z.string().uuid() }),
  held,
  sessionMissing,
  invalid,
  modeMismatch,
]);
export type RegisterTenureOutcome = z.infer<typeof registerSchema>;

export type ExpectedTenurePrior =
  | { kind: 'never_owned' }
  | { kind: 'released' | 'reconciled'; tenureId: string };

export interface RegisterTenureInput {
  sessionId: string;
  expected: ExpectedTenurePrior;
  mode: TenureMode;
  capabilityHash: string;
  host: { instanceId: string; bootId?: string; hostId?: string };
  /** The verified identity of the process that owns the backend, when known. */
  owner?: { pid: number; startIdentity: string };
  endpoint?: Record<string, unknown>;
}

export async function registerTenure(
  client: SupabaseClient,
  input: RegisterTenureInput
): Promise<RegisterTenureOutcome> {
  const { data, error } = await client.rpc('register_tenure', {
    p_session_id: input.sessionId,
    p_expected: input.expected,
    p_mode: input.mode,
    p_capability_hash: input.capabilityHash,
    p_host: input.host,
    p_owner: input.owner ?? null,
    p_endpoint: input.endpoint ?? null,
    p_protocol: ADMISSION_PROTOCOL,
  });
  return parseReply(registerSchema, 'register_tenure', data, error);
}

const admitSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('admitted'), epoch: z.string() }),
  z.object({ outcome: z.literal('stale_expectation'), epoch: z.string().nullable() }),
  z.object({ outcome: z.literal('unverified'), epoch: z.string() }),
  z.object({ outcome: z.literal('busy'), epoch: z.string() }),
  z.object({ outcome: z.literal('unresolved'), epoch: z.string().nullable() }),
  z.object({ outcome: z.literal('not_fifo_head'), head: z.string().uuid().nullable() }),
  held,
  notHolder,
  sessionMissing,
  invalid,
  modeMismatch,
]);
export type AdmitTurnOutcome = z.infer<typeof admitSchema>;

export interface AdmitTurnInput {
  sessionId: string;
  holder: TenureHolder;
  /** The session's current turn epoch as read, or null before its first turn. */
  expectedPriorEpoch: string | null;
  epoch: string;
  commandUuid: string;
}

export async function admitTurn(
  client: SupabaseClient,
  input: AdmitTurnInput
): Promise<AdmitTurnOutcome> {
  const { data, error } = await client.rpc('admit_turn', {
    p_session_id: input.sessionId,
    p_tenure_id: input.holder.tenureId,
    p_capability_hash: tenureCapabilityHash(input.holder.capability),
    p_host_instance_id: input.holder.hostInstanceId,
    p_expected_prior_epoch: input.expectedPriorEpoch,
    p_epoch: input.epoch,
    p_command_uuid: input.commandUuid,
    p_protocol: ADMISSION_PROTOCOL,
  });
  return parseReply(admitSchema, 'admit_turn', data, error);
}

const leasedAdmitSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('admitted'),
    epoch: z.string(),
    // At least the named lease: an admission that moved no lease is outside
    // the contract, whatever the database says.
    restamped: z.number().int().positive(),
  }),
  z.object({ outcome: z.literal('stale_expectation'), epoch: z.string().nullable() }),
  z.object({ outcome: z.literal('unverified'), epoch: z.string() }),
  z.object({ outcome: z.literal('busy'), epoch: z.string() }),
  z.object({ outcome: z.literal('unresolved'), epoch: z.string().nullable() }),
  z.object({ outcome: z.literal('not_fifo_head'), head: z.string().uuid().nullable() }),
  /** The named studio's lease is not this session's live lease, or the studio is gone. */
  z.object({ outcome: z.literal('lease_lost') }),
  /** The studio belongs to another tenant than the session. */
  z.object({ outcome: z.literal('forbidden') }),
  held,
  notHolder,
  sessionMissing,
  invalid,
  modeMismatch,
]);
export type AdmitLeasedTurnOutcome = z.infer<typeof leasedAdmitSchema>;

/**
 * Admits a turn exactly as {@link admitTurn} does, for a session that holds
 * the named studio's lease, and moves the session's live leases to the new
 * epoch in the same transaction. A refusal is returned unchanged: a
 * `stale_expectation` naming the caller's own epoch is a refusal and carries
 * no permission to dispatch. `restamped` counts the leases moved to the epoch.
 */
export async function admitLeasedTurn(
  client: SupabaseClient,
  input: AdmitTurnInput & { studioId: string }
): Promise<AdmitLeasedTurnOutcome> {
  const { data, error } = await client.rpc('admit_leased_turn', {
    p_session_id: input.sessionId,
    p_tenure_id: input.holder.tenureId,
    p_capability_hash: tenureCapabilityHash(input.holder.capability),
    p_host_instance_id: input.holder.hostInstanceId,
    p_expected_prior_epoch: input.expectedPriorEpoch,
    p_epoch: input.epoch,
    p_command_uuid: input.commandUuid,
    p_studio_id: input.studioId,
    p_protocol: ADMISSION_PROTOCOL,
  });
  return parseReply(leasedAdmitSchema, 'admit_leased_turn', data, error);
}

const finishSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('finished'), epoch: z.string() }),
  z.object({
    outcome: z.literal('stale'),
    epoch: z.string().nullable(),
    state: z.string().nullable(),
  }),
  notHolder,
  sessionMissing,
  invalid,
  modeMismatch,
]);
export type FinishTurnOutcome = z.infer<typeof finishSchema>;

export async function finishTurn(
  client: SupabaseClient,
  input: { sessionId: string; holder: TenureHolder; epoch: string; evidence: string }
): Promise<FinishTurnOutcome> {
  const { data, error } = await client.rpc('finish_turn', {
    p_session_id: input.sessionId,
    p_tenure_id: input.holder.tenureId,
    p_capability_hash: tenureCapabilityHash(input.holder.capability),
    p_host_instance_id: input.holder.hostInstanceId,
    p_epoch: input.epoch,
    p_evidence: input.evidence,
    p_protocol: ADMISSION_PROTOCOL,
  });
  return parseReply(finishSchema, 'finish_turn', data, error);
}

/** What ended the tenure. None of them stands in for spawn evidence. */
export type TenureReleaseEvidence =
  | 'wrapper_exit_tree_quiescent'
  | 'controller_retired'
  | 'native_wrapper_exit_tree_quiescent';

const releaseSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('released'), tenureId: z.string().uuid() }),
  z.object({ outcome: z.literal('busy') }),
  z.object({ outcome: z.literal('unresolved'), invocations: z.number().int().positive() }),
  held,
  notHolder,
  sessionMissing,
  invalid,
  modeMismatch,
]);
export type ReleaseTenureOutcome = z.infer<typeof releaseSchema>;

export async function releaseTenure(
  client: SupabaseClient,
  input: { sessionId: string; holder: TenureHolder; evidence: TenureReleaseEvidence }
): Promise<ReleaseTenureOutcome> {
  const { data, error } = await client.rpc('release_tenure', {
    p_session_id: input.sessionId,
    p_tenure_id: input.holder.tenureId,
    p_capability_hash: tenureCapabilityHash(input.holder.capability),
    p_host_instance_id: input.holder.hostInstanceId,
    p_evidence: input.evidence,
    p_protocol: ADMISSION_PROTOCOL,
  });
  return parseReply(releaseSchema, 'release_tenure', data, error);
}

/**
 * One fact about one spawn, under the invocation identity the journal uses.
 * `group_empty` and `parent_exited` are recorded as what they are and never
 * resolve a spawn; `tree_quiescent` and `not_spawned` name the evidence
 * actually checked.
 */
export type InvocationRecord =
  | { kind: 'intent' }
  | { kind: 'process_binding'; pid: number; startIdentity: string }
  | { kind: 'transcript_binding'; providerTranscriptId: string }
  | { kind: 'parent_exited' }
  | { kind: 'group_empty' }
  | { kind: 'tree_quiescent'; evidenceRef: string }
  | { kind: 'not_spawned'; evidenceRef: string }
  | { kind: 'unknown'; reasonCode: string };

const recordSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('recorded'), kind: z.string() }),
  z.object({ outcome: z.literal('already_recorded'), kind: z.string() }),
  z.object({ outcome: z.literal('contradiction'), kind: z.string() }),
  /** The holder recorded this spawn unknown; only a reconciler resolves it now. */
  z.object({ outcome: z.literal('needs_reconciler'), kind: z.string() }),
  z.object({ outcome: z.literal('no_intent') }),
  z.object({ outcome: z.literal('stale') }),
  notHolder,
  sessionMissing,
  invalid,
  modeMismatch,
]);
export type RecordInvocationOutcome = z.infer<typeof recordSchema>;

export async function recordInvocation(
  client: SupabaseClient,
  input: {
    sessionId: string;
    holder: TenureHolder;
    epoch: string;
    invocationId: string;
    record: InvocationRecord;
  }
): Promise<RecordInvocationOutcome> {
  const { kind, ...detail } = input.record;
  const { data, error } = await client.rpc('record_invocation', {
    p_session_id: input.sessionId,
    p_tenure_id: input.holder.tenureId,
    p_capability_hash: tenureCapabilityHash(input.holder.capability),
    p_host_instance_id: input.holder.hostInstanceId,
    p_epoch: input.epoch,
    p_invocation_id: input.invocationId,
    p_kind: kind,
    p_detail: detail,
    p_protocol: ADMISSION_PROTOCOL,
  });
  return parseReply(recordSchema, 'record_invocation', data, error);
}

const lostSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('recovery_required'), tenureId: z.string().uuid() }),
  z.object({ outcome: z.literal('stale'), state: z.string().nullable().optional() }),
  invalid,
  modeMismatch,
]);
export type MarkTenureLostOutcome = z.infer<typeof lostSchema>;

/** Reconciler path: the holder is gone without full evidence. */
export async function markTenureLost(
  client: SupabaseClient,
  input: { sessionId: string; tenureId: string; authority: string; reasonCode: string }
): Promise<MarkTenureLostOutcome> {
  const { data, error } = await client.rpc('mark_tenure_lost', {
    p_session_id: input.sessionId,
    p_tenure_id: input.tenureId,
    p_authority: input.authority,
    p_reason: input.reasonCode,
    p_protocol: ADMISSION_PROTOCOL,
  });
  return parseReply(lostSchema, 'mark_tenure_lost', data, error);
}

/**
 * The legacy session state a quiescence attestation is bound to, as the
 * database reads it (`session_legacy_state`). Every field is named, null
 * included; timestamps compare as instants.
 */
export interface LegacySessionState {
  turnEpoch: string | null;
  backendSessionId: string | null;
  lifecycle: string | null;
  cliTurnAt: string | null;
  cliTurnStoppedAt: string | null;
  updatedAt: string | null;
}

const legacyStateSchema = z
  .object({
    turnEpoch: z.string().nullable(),
    backendSessionId: z.string().nullable(),
    lifecycle: z.string().nullable(),
    cliTurnAt: z.string().nullable(),
    cliTurnStoppedAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict();

const reconcileSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('reconciled'), tenureId: z.string().uuid() }),
  z.object({ outcome: z.literal('refused'), reason: z.string() }),
  z.object({ outcome: z.literal('stale'), state: z.string().nullable().optional() }),
  /** `legacy` is the current state when a legacy attestation no longer matches it. */
  z.object({
    outcome: z.literal('stale_expectation'),
    tenureId: z.string().uuid().nullable(),
    legacy: legacyStateSchema.optional(),
  }),
  sessionMissing,
  invalid,
  modeMismatch,
]);
export type ReconcileTenureOutcome = z.infer<typeof reconcileSchema>;

/**
 * Reconciler path. Every kind clears process overlap only, and the tenure keeps
 * the proof it was cleared on.
 * - `boot_changed` needs the tenure's recorded machine (`host.hostId`) to be the
 *   current machine and its recorded boot id to differ from the current one. A
 *   different machine or a new host instance is not a reboot.
 * - `owner_tree_gone` needs the attestation the reconciler actually checked.
 * - `legacy_quiescence_attested` clears unverified history only (no tenure): the
 *   reconciler on `currentHostId` verified no process of the legacy runtime
 *   alive (`evidenceRef`), bound to the state it inspected (`expectedLegacy`).
 *   A changed row is `stale_expectation`, with the current state to re-inspect.
 * - `operator_decision` is always refused: it accepts effect risk and never
 *   proves a process gone.
 */
export async function reconcileTenure(
  client: SupabaseClient,
  input: {
    sessionId: string;
    expectedTenureId: string | null;
    evidence:
      | 'boot_changed'
      | 'owner_tree_gone'
      | 'legacy_quiescence_attested'
      | 'operator_decision';
    currentBootId?: string;
    /** The machine the reconciler runs on, for `boot_changed` and a legacy attestation. */
    currentHostId?: string;
    evidenceRef?: string;
    /** The inspected legacy state, for `legacy_quiescence_attested` only. */
    expectedLegacy?: LegacySessionState;
    authority: string;
    hostInstanceId: string;
  }
): Promise<ReconcileTenureOutcome> {
  const { data, error } = await client.rpc('reconcile_tenure', {
    p_session_id: input.sessionId,
    p_expected_tenure_id: input.expectedTenureId,
    p_evidence: input.evidence,
    p_current_boot_id: input.currentBootId ?? null,
    p_current_host_id: input.currentHostId ?? null,
    p_evidence_ref: input.evidenceRef ?? null,
    p_expected_legacy: input.expectedLegacy ?? null,
    p_authority: input.authority,
    p_host_instance_id: input.hostInstanceId,
    p_protocol: ADMISSION_PROTOCOL,
  });
  return parseReply(reconcileSchema, 'reconcile_tenure', data, error);
}
