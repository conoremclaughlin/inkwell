/**
 * An inkling's turn and its owner's connected accounts.
 *
 * An inkling acts for its owner, and the owner's Google connection is
 * looked up by the owner's user and the inkling's workspace. So without a
 * check here, every Google tool (Gmail, Calendar, Docs, Drive, Sheets) runs
 * against the owner's account from an inkling's turn, send_email included.
 * The ink tools tier does not stop that: it is one profile for every SB on
 * that tier, enforced by the ink client, and it denies only the shell, file
 * edits and writes, view_image, trigger_agent and send_response.
 *
 * This is the server's refusal, at the one place a connected account's
 * token is handed out (OAuthService.getValidAccessToken), before any
 * account is read. When the calling SB is an inkling, no token is handed
 * out unless the tool the call runs inside is named in
 * INK_INKLING_ACCOUNT_TOOLS (inklingAccountToolAllowlist). Unset, that is
 * none. A tool added later that reaches an account is covered without being
 * listed anywhere: it is refused to inklings until it is named.
 *
 * Who is calling, from the request context:
 * - the SB the bearer token was minted for (tokenSbId, signed);
 * - the SB the context names (sbId, which may come from the caller's
 *   session rather than the token);
 * - the slugs beside them, looked up among all of the account owner's
 *   identities, in every workspace.
 * Any one being an inkling is enough. No SB at all (a person, or work
 * outside a request) is not gated. A failed identity read refuses.
 *
 * Being an inkling is read from metadata.client, which no identity write can
 * change (assertInklingStatusKept in identity-handlers.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { inklingAccountToolAllowlist } from '../../config/inkling-flags';
import { logger } from '../../utils/logger';
import {
  getRequestContext,
  getSessionContext,
  type RequestContextData,
} from '../../utils/request-context';
import { currentToolName } from '../../utils/tool-call-context';
import { INKLING_CLIENT } from './inkling-client';

export class InklingAccountRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InklingAccountRefusedError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The SBs a request context says are calling, UUIDs and slugs apart. */
export interface AccountGateCaller {
  sbIds: string[];
  sbSlugs: string[];
}

export function accountGateCaller(
  context: Partial<RequestContextData> | undefined = getRequestContext() ?? getSessionContext()
): AccountGateCaller {
  const unique = (values: Array<string | undefined>) => [
    ...new Set(values.filter((value): value is string => !!value && value.trim() !== '')),
  ];
  const ids = unique([context?.tokenSbId, context?.sbId]);
  return {
    sbIds: ids.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()),
    sbSlugs: unique([context?.tokenSlug, context?.sbSlug]),
  };
}

interface IdentityRow {
  id: string;
  metadata: Record<string, unknown> | null;
}

/**
 * The inklings among the caller's SBs. UUIDs and slugs are both read: a
 * token minted with a slug alone, beside a context naming another SB by
 * UUID, must not pass on the UUID.
 *
 * A slug is read among all of the account owner's identities, never only in
 * the request's workspace. A slug-only token is bound to no workspace, and
 * the caller picks the request's workspace with a header from any it can
 * reach, so reading the slug there let an inkling's token pass from a
 * workspace where its slug is missing or names an ordinary SB (Lumen,
 * PR #793). An inkling's slug is `kindle-<token id>` and never renamed, so an
 * ordinary SB elsewhere doesn't share it by chance.
 */
async function callingInklings(
  supabase: SupabaseClient,
  ownerUserId: string,
  caller: AccountGateCaller
): Promise<IdentityRow[]> {
  const reads: Array<PromiseLike<{ data: unknown; error: { message: string } | null }>> = [];
  if (caller.sbIds.length > 0) {
    reads.push(supabase.from('agent_identities').select('id, metadata').in('id', caller.sbIds));
  }
  if (caller.sbSlugs.length > 0) {
    reads.push(
      supabase
        .from('agent_identities')
        .select('id, metadata')
        .eq('user_id', ownerUserId)
        .in('agent_id', caller.sbSlugs)
    );
  }
  const rows: IdentityRow[] = [];
  for (const { data, error } of await Promise.all(reads)) {
    if (error) {
      throw new InklingAccountRefusedError(
        `Could not read the calling SB to check whether it is an inkling: ${error.message}`
      );
    }
    rows.push(...((data ?? []) as IdentityRow[]));
  }
  return rows.filter((row) => row.metadata?.client === INKLING_CLIENT);
}

/**
 * Refuses (throws) when the caller is an inkling and the tool it runs inside
 * is not turned on for inklings. Called before any account is looked up.
 */
export async function assertAccountTokenAllowed(
  supabase: SupabaseClient,
  provider: string,
  ownerUserId: string,
  options: {
    caller?: AccountGateCaller;
    toolName?: string;
    allowlist?: ReadonlySet<string>;
  } = {}
): Promise<void> {
  const caller = options.caller ?? accountGateCaller();
  const inklings = await callingInklings(supabase, ownerUserId, caller);
  if (inklings.length === 0) return;
  const toolName = options.toolName ?? currentToolName();
  const allowlist = options.allowlist ?? inklingAccountToolAllowlist().tools;
  if (toolName && allowlist.has(toolName)) return;
  logger.warn("Refused an inkling's turn its owner's connected account", {
    provider,
    tool: toolName ?? null,
    sbIds: inklings.map((row) => row.id),
  });
  throw new InklingAccountRefusedError(
    `${toolName ?? 'This call'} can't use its owner's ${provider} account in an inkling's turn: ` +
      'it is not turned on for inklings on this server.'
  );
}
