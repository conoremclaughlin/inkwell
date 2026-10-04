/**
 * Durable command admission (ink://specs/live-agent-surfaces R3/R4), over the
 * database functions in migration 20261004094856.
 *
 * Every authorized source submits to one resolved session; admission gives
 * the command its place in that session's single order and stores its
 * identity and payload before anything acknowledges it. A command belongs to
 * the session, not to whichever owner later executes it.
 *
 * DARK. Nothing in the server calls this yet, and the database starts in
 * `legacy` mode, where admission and transitions return `mode_mismatch`.
 * `readDispatchHead` is a read, not dispatch authority, and is not mode-gated.
 * Parsing is strict:
 * a reply outside the contract throws, so an unknown outcome is never read as
 * success or as refusal.
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/** The admission protocol this server speaks; the database refuses any other. */
export const ADMISSION_PROTOCOL = 1;

/** Version of the canonical payload digest below. */
export const COMMAND_DIGEST_VERSION = 1;

export const COMMAND_STATES = [
  'stored',
  'queued',
  'waiting_for_consumer',
  'backend_accepted',
  'input_consumed',
  'completed',
  'rejected',
  'interrupted',
  'unknown',
] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

export type CommandKind = 'input.enqueue' | 'session.compact';
export type CommandOriginKind =
  | 'terminal'
  | 'browser'
  | 'channel'
  | 'inkmail'
  | 'wake'
  | 'internal';
export type PrincipalKind = 'user' | 'sb' | 'system';

/** Who is owed a receipt for a revision, beyond the command's originator. */
export interface CommandRecipient {
  kind: 'user' | 'sb' | 'operator';
  id: string;
}

export interface AdmitCommandInput {
  /** Already resolved and authorized by routing; admission never re-routes. */
  sessionId: string;
  workspaceId: string;
  principal: { kind: PrincipalKind; id: string };
  /** Stable across transport retries of the same submission. */
  commandId: string;
  kind: CommandKind;
  origin: { kind: CommandOriginKind; ref?: string };
  addressee?: string;
  /** The body, for every source except Inkmail. */
  payload?: unknown;
  /** The thread message, for Inkmail: its body stays in the message. */
  sourceMessageRef?: string;
  expectedTurn?: string;
  recipients?: CommandRecipient[];
}

const stateSchema = z.enum(COMMAND_STATES);

const admitOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('admitted'),
    id: z.string().uuid(),
    admissionSeq: z.number().int().positive(),
    state: stateSchema,
    revision: z.number().int().positive(),
  }),
  z.object({
    outcome: z.literal('existing'),
    id: z.string().uuid(),
    admissionSeq: z.number().int().positive(),
    state: stateSchema,
    revision: z.number().int().positive(),
  }),
  z.object({ outcome: z.literal('conflict'), id: z.string().uuid() }),
  z.object({ outcome: z.literal('too_large'), limitBytes: z.number().int().positive() }),
  z.object({ outcome: z.literal('forbidden') }),
  z.object({ outcome: z.literal('session_missing') }),
  z.object({ outcome: z.literal('source_unavailable') }),
  z.object({ outcome: z.literal('invalid'), field: z.string() }),
  z.object({
    outcome: z.literal('mode_mismatch'),
    mode: z.string().nullable(),
    protocol: z.number().int().nullable(),
  }),
]);
export type AdmitCommandOutcome = z.infer<typeof admitOutcomeSchema>;

const transitionOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('transitioned'),
    revision: z.number().int().positive(),
    state: stateSchema,
  }),
  z.object({
    outcome: z.literal('stale'),
    revision: z.number().int().positive(),
    state: stateSchema,
  }),
  z.object({ outcome: z.literal('illegal_transition'), from: stateSchema, to: stateSchema }),
  z.object({ outcome: z.literal('notice_required') }),
  z.object({ outcome: z.literal('missing') }),
  z.object({ outcome: z.literal('invalid'), field: z.string() }),
  z.object({
    outcome: z.literal('mode_mismatch'),
    mode: z.string().nullable(),
    protocol: z.number().int().nullable(),
  }),
]);
export type TransitionCommandOutcome = z.infer<typeof transitionOutcomeSchema>;

/**
 * `recovery_required`: a started command's outcome is unknown.
 * `unresolved_dispatch`: a command was handed off or accepted and nothing
 * terminal has been recorded since — including when that write was lost.
 */
const dispatchHeadSchema = z.union([
  z.object({
    hold: z.enum(['recovery_required', 'unresolved_dispatch']),
    holdingCommand: z.string().uuid(),
    head: z.null(),
  }),
  z.object({ hold: z.null(), holdingCommand: z.null(), head: z.string().uuid().nullable() }),
]);
export type DispatchHead = z.infer<typeof dispatchHeadSchema>;

/**
 * The payload exactly as JSON transport carries it to the database: `toJSON`
 * runs once, array holes and non-finite numbers become null, and undefined
 * members drop out. Admission hashes and sends this one value, so the row
 * stores what the digest covers. A payload JSON cannot carry (a BigInt, a
 * cycle, a bare function) is refused here rather than sent as something else.
 */
export function toJsonPayload(payload: unknown): unknown {
  if (payload === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(payload);
  } catch {
    text = undefined;
  }
  if (text === undefined) throw new Error('command payload is not representable as JSON');
  return JSON.parse(text);
}

/** Sorted keys at every depth over a JSON value, so equal values serialize equally. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The versioned digest that decides whether a repeat is the same command.
 * It covers the immutable target, the authenticated origin, the addressee and
 * the expected-turn binding as well as the body, so the same id and text
 * aimed at another session, turn or addressee is a conflict, not a duplicate.
 * Transport credentials are never part of it. The database also compares the
 * envelope itself, so a caller's digest is not the only guard.
 */
export function commandPayloadDigest(input: {
  sessionId: string;
  kind: CommandKind;
  origin?: { kind: CommandOriginKind; ref?: string };
  addressee?: string;
  payload?: unknown;
  sourceMessageRef?: string;
  expectedTurn?: string;
}): string {
  const canonical = canonicalJson({
    v: COMMAND_DIGEST_VERSION,
    sessionId: input.sessionId,
    kind: input.kind,
    origin: input.origin && { kind: input.origin.kind, ref: input.origin.ref },
    addressee: input.addressee,
    payload: toJsonPayload(input.payload),
    sourceMessageRef: input.sourceMessageRef,
    expectedTurn: input.expectedTurn,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
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

export async function admitCommand(
  client: SupabaseClient,
  input: AdmitCommandInput
): Promise<AdmitCommandOutcome> {
  // Normalized once: the digest and the RPC carry this same value.
  const payload = toJsonPayload(input.payload);
  const { data, error } = await client.rpc('admit_command', {
    p_session_id: input.sessionId,
    p_workspace_id: input.workspaceId,
    p_principal_kind: input.principal.kind,
    p_principal_id: input.principal.id,
    p_command_id: input.commandId,
    p_payload_digest: commandPayloadDigest({ ...input, payload }),
    p_digest_version: COMMAND_DIGEST_VERSION,
    p_kind: input.kind,
    p_origin_kind: input.origin.kind,
    p_origin_ref: input.origin.ref ?? null,
    p_addressee: input.addressee ?? null,
    p_payload: payload === undefined ? null : payload,
    p_source_message_ref: input.sourceMessageRef ?? null,
    p_expected_turn: input.expectedTurn ?? null,
    p_recipients: input.recipients ?? [],
    p_protocol: ADMISSION_PROTOCOL,
  });
  return parseReply(admitOutcomeSchema, 'admit_command', data, error);
}

export interface TransitionCommandInput {
  commandUuid: string;
  /** The revision and state this caller read; anything else is `stale`. */
  expected: { revision: number; state: CommandState };
  to: CommandState;
  reasonCode?: string;
  /** Mark the command started before a handoff whose outcome is not known yet. */
  markStarted?: boolean;
  executingEpoch?: string;
  recipients?: CommandRecipient[];
}

export async function transitionCommand(
  client: SupabaseClient,
  input: TransitionCommandInput
): Promise<TransitionCommandOutcome> {
  const { data, error } = await client.rpc('transition_command', {
    p_command_uuid: input.commandUuid,
    p_expected_revision: input.expected.revision,
    p_expected_state: input.expected.state,
    p_new_state: input.to,
    p_reason_code: input.reasonCode ?? null,
    p_mark_started: input.markStarted ?? false,
    p_executing_epoch: input.executingEpoch ?? null,
    p_recipients: input.recipients ?? [],
    p_protocol: ADMISSION_PROTOCOL,
  });
  return parseReply(transitionOutcomeSchema, 'transition_command', data, error);
}

/**
 * The command the next ordinary turn may take, or the hold that stops it.
 * A read: it reserves nothing, and turn admission re-checks it under the
 * session lock.
 */
export async function readDispatchHead(
  client: SupabaseClient,
  sessionId: string
): Promise<DispatchHead> {
  const { data, error } = await client.rpc('session_dispatch_head', { p_session_id: sessionId });
  return parseReply(dispatchHeadSchema, 'session_dispatch_head', data, error);
}
