/**
 * Workspace-scoped row resolution for the identity tables.
 *
 * Sep 10 2026 incident (Myra): `save_identity` called without a workspaceId
 * inserted an unscoped twin of her workspace-scoped identity. From then on
 * every reader matched two rows, `.single()` failed with PGRST116, and each
 * handler reported that as "No identity found" — when the truth was "found
 * two". The August duplicates for wren and echo had the same shape.
 *
 * Two rules, applied everywhere a lookup may be unscoped:
 *   - read EVERY row for the key and decide explicitly — never `.single()`,
 *     and never a truncated page (a limit can hide a second scoped row);
 *   - when a scoped row and an unscoped twin both match, the scoped row is
 *     the identity and the twin is the accident — prefer it and log. Two
 *     scoped rows with no scope given is a real ambiguity: say so, name the
 *     count, and ask for workspaceId. Never report it as "not found".
 */
import { logger } from '../../utils/logger';

/** Adds `.eq('workspace_id', id)` when a scope is given; otherwise the query stays unfiltered. */
export function withWorkspaceFilter<T>(query: T, workspaceId?: string): T {
  if (!workspaceId) return query;
  return (query as { eq: (column: string, value: string) => T }).eq('workspace_id', workspaceId);
}

export class WorkspaceRowAmbiguityError extends Error {
  readonly code = 'WORKSPACE_ROW_AMBIGUOUS';
  constructor(
    readonly subject: string,
    readonly rowCount: number
  ) {
    super(`Multiple rows found for ${subject} (${rowCount}); pass workspaceId to disambiguate`);
    this.name = 'WorkspaceRowAmbiguityError';
  }
}

/**
 * Pick the one row an (optionally unscoped) lookup should mean.
 * 0 rows → null. 1 row → it. 2+ rows → the single workspace-scoped row when
 * exactly one exists; otherwise throw WorkspaceRowAmbiguityError. The caller
 * must pass the COMPLETE candidate set — uniqueness is decided here.
 * Accepts an array (PostgREST) or a bare object (single-row clients/mocks).
 */
export function pickWorkspaceScopedRow<T extends { workspace_id: string | null }>(
  data: unknown,
  subject: string
): T | null {
  const rows: T[] = Array.isArray(data) ? (data as T[]) : data ? [data as T] : [];
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  const scoped = rows.filter((row) => row.workspace_id !== null);
  if (scoped.length === 1) {
    logger.warn('[WorkspaceRow] Unscoped twin present; preferring the workspace-scoped row', {
      subject,
      rows: rows.length,
    });
    return scoped[0];
  }
  throw new WorkspaceRowAmbiguityError(subject, rows.length);
}
