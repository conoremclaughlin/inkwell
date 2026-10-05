import type { SupabaseClient } from '@supabase/supabase-js';
import {
  canonicalJournalJson,
  freezeJournalEntry,
  type JournalEntry,
} from '@inklabs/shared/runtime';

export interface JournalReadScope {
  sessionId: string;
  journalId: string;
}
export interface JournalReadCursor {
  journalId: string;
  /** Last scanned canonical entry, including entries a downstream view hides. */
  afterEid: number;
}
export interface SessionJournalPage {
  readonly entries: readonly Readonly<JournalEntry>[];
  readonly cursor: Readonly<JournalReadCursor>;
  /** Snapshot ceiling: carry forward to read a finite, consistent prefix. */
  readonly throughEid: number;
  /** Head observed this call; NOT dispatch authority or an incarnation proof. */
  readonly committedEid: number;
  /** A held lineage is readable history, never permission to resume. */
  readonly holdReason: string | null;
  readonly more: boolean;
}
export class SessionJournalReadError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'forbidden'
      | 'unavailable'
      | 'cursor_ahead'
      | 'transport_failed'
      | 'invalid_page'
      | 'page_too_small'
  ) {
    super(`Session journal read: ${code}`);
    this.name = 'SessionJournalReadError';
  }
}

const MAX_ENTRY_BYTES = 256 * 1024;
// SQL counts uncompressed jsonb text (spacing and decimal number expansion),
// not JS compact JSON or TOAST's compressed storage size.
const MAX_STORED_ENTRY_BYTES = 512 * 1024;
const PAGE_OVERHEAD = 512;

/**
 * Full participant-authorized replay, not an observer endpoint. DARK/unwired.
 * The host supplies a scoped service client and a current access check. Check
 * before any query, again before loading payloads, and before returning them;
 * no stale captured boolean is a substitute for the host's authorization.
 * Observer filtering/preview guarding happens separately, before any fanout.
 *
 * First select bounded metadata, then only the contiguous prefix whose bodies
 * fit the byte budget. Never materialize 128 maximum-sized entries just to
 * truncate to one MiB afterwards. Stored entry_bytes must conservatively bound
 * the JSON payload (the SQL seal maintains it). Missing/gapped/corrupt rows
 * refuse the entire page. No fallback, offset paging, cursor reset or pruning.
 * This validates a read prefix, NOT database incarnation or recovery safety.
 */
export async function readSessionJournalPage(
  client: SupabaseClient,
  options: {
    scope: JournalReadScope;
    cursor: JournalReadCursor;
    throughEid?: number;
    maxEntries?: number;
    maxPageBytes?: number;
    authorize(scope: Readonly<JournalReadScope>): Promise<boolean>;
  }
): Promise<SessionJournalPage> {
  let scope: Readonly<JournalReadScope>;
  let afterEid: number;
  let throughEid: number | undefined;
  let maxEntries: number;
  let maxPageBytes: number;
  let authorize: typeof options.authorize;
  try {
    authorize = options.authorize;
    scope = Object.freeze(JSON.parse(canonicalJournalJson(options.scope, 256)) as JournalReadScope);
    const cursor = JSON.parse(canonicalJournalJson(options.cursor, 256)) as JournalReadCursor;
    if (
      Object.keys(scope).sort().join(',') !== 'journalId,sessionId' ||
      Object.keys(cursor).sort().join(',') !== 'afterEid,journalId' ||
      !uuid(scope.sessionId) ||
      !uuid(scope.journalId) ||
      cursor.journalId !== scope.journalId ||
      typeof authorize !== 'function'
    )
      throw new Error();
    afterEid = cursor.afterEid;
    throughEid = options.throughEid;
    maxEntries = options.maxEntries === undefined ? 128 : options.maxEntries;
    maxPageBytes = options.maxPageBytes === undefined ? 1024 * 1024 : options.maxPageBytes;
    if (
      !cursorNumber(afterEid) ||
      (throughEid !== undefined && (!cursorNumber(throughEid) || throughEid < afterEid)) ||
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 128 ||
      !Number.isSafeInteger(maxPageBytes) ||
      maxPageBytes < 1024 ||
      maxPageBytes > 1024 * 1024
    )
      throw new Error();
  } catch {
    throw new SessionJournalReadError('invalid_request');
  }

  const requireAccess = async (): Promise<void> => {
    let allowed = false;
    try {
      allowed = (await authorize(scope)) === true;
    } catch {
      /* Fail closed, no error reflection. */
    }
    if (!allowed) throw new SessionJournalReadError('forbidden');
  };
  await requireAccess();
  const rawHeader = await query(() =>
    client
      .from('session_journals')
      .select('id,session_id,kind,committed_eid,hold_reason')
      .eq('id', scope.journalId)
      .eq('session_id', scope.sessionId)
      .maybeSingle()
  );
  if (rawHeader === null) throw new SessionJournalReadError('unavailable');
  const header = plain(rawHeader, 1024);
  if (
    header.id !== scope.journalId ||
    header.session_id !== scope.sessionId ||
    header.kind !== 'db_v1' ||
    !cursorNumber(header.committed_eid) ||
    !(
      header.hold_reason === null ||
      (typeof header.hold_reason === 'string' && /^[a-z0-9_.:-]{1,100}$/.test(header.hold_reason))
    )
  )
    invalidPage();
  const committedEid = header.committed_eid as number;
  if (afterEid > committedEid || (throughEid !== undefined && throughEid > committedEid))
    throw new SessionJournalReadError('cursor_ahead');
  throughEid ??= committedEid;
  const entries: Readonly<JournalEntry>[] = [];
  let scanned = afterEid;

  if (afterEid < throughEid) {
    const expectedCount = Math.min(maxEntries, throughEid - afterEid);
    const metadata = array(
      await query(() =>
        client
          .from('session_journal_entries')
          .select('eid,entry_bytes')
          .eq('journal_id', scope.journalId)
          .gt('eid', afterEid)
          .lte('eid', throughEid)
          .order('eid', { ascending: true })
          .limit(expectedCount)
      ),
      expectedCount * 128 + 2
    );
    if (metadata.length !== expectedCount) invalidPage();
    const chosen: Array<{ eid: number; bytes: number }> = [];
    let remaining = maxPageBytes - PAGE_OVERHEAD;
    for (let i = 0; i < metadata.length; i++) {
      const row = plain(metadata[i], 128);
      if (
        row.eid !== afterEid + i + 1 ||
        !cursorNumber(row.entry_bytes) ||
        (row.entry_bytes as number) < 1 ||
        (row.entry_bytes as number) > MAX_STORED_ENTRY_BYTES
      )
        invalidPage();
      const bytes = row.entry_bytes as number;
      // Also bound the row wrapper on the DB response, not only the final page.
      const cost = bytes + 128;
      if (chosen.length === i && cost <= remaining) {
        chosen.push({ eid: row.eid as number, bytes });
        remaining -= cost;
      }
    }
    if (chosen.length === 0) throw new SessionJournalReadError('page_too_small');
    await requireAccess();
    const last = chosen[chosen.length - 1].eid;
    const rows = array(
      await query(() =>
        client
          .from('session_journal_entries')
          .select('eid,entry')
          .eq('journal_id', scope.journalId)
          .gt('eid', afterEid)
          .lte('eid', last)
          .order('eid', { ascending: true })
          .limit(chosen.length)
      ),
      maxPageBytes
    );
    if (rows.length !== chosen.length) invalidPage();
    for (let i = 0; i < rows.length; i++) {
      const row = plain(rows[i], chosen[i].bytes + 128);
      let snapshot: ReturnType<typeof freezeJournalEntry>;
      try {
        snapshot = freezeJournalEntry(row.entry, MAX_ENTRY_BYTES);
      } catch {
        invalidPage();
      }
      if (
        row.eid !== chosen[i].eid ||
        snapshot.entry.eid !== row.eid ||
        snapshot.entry.sessionId !== scope.sessionId ||
        snapshot.entry.journalId !== scope.journalId ||
        snapshot.bytes > chosen[i].bytes
      )
        invalidPage();
      entries.push(snapshot.entry);
    }
    scanned = last;
  }
  await requireAccess();
  const page = Object.freeze({
    entries: Object.freeze(entries),
    cursor: Object.freeze({ journalId: scope.journalId, afterEid: scanned }),
    throughEid,
    committedEid,
    holdReason: header.hold_reason as string | null,
    more: scanned < throughEid,
  });
  try {
    canonicalJournalJson(page, maxPageBytes);
  } catch {
    invalidPage();
  }
  return page;
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}
function cursorNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function invalidPage(): never {
  throw new SessionJournalReadError('invalid_page');
}
function plain(value: unknown, maxBytes: number): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(canonicalJournalJson(value, maxBytes));
    if (!data || typeof data !== 'object' || Array.isArray(data)) invalidPage();
    return data as Record<string, unknown>;
  } catch {
    return invalidPage();
  }
}
function array(value: unknown, maxBytes: number): unknown[] {
  try {
    const data: unknown = JSON.parse(canonicalJournalJson(value, maxBytes));
    if (!Array.isArray(data)) invalidPage();
    return data;
  } catch {
    return invalidPage();
  }
}
async function query(run: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<unknown> {
  try {
    const result = await run();
    if (result.error) throw new Error();
    return result.data;
  } catch {
    throw new SessionJournalReadError('transport_failed');
  }
}
