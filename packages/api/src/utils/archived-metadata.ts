/**
 * Reads of archived memory metadata.
 *
 * Deliberately its own module with NO side effects. routes/admin.ts registers
 * ~100 Express routes and an auth middleware at module scope, so importing it
 * to reach one predicate executes all of that and drags in the whole admin
 * surface (Lumen, PR #635).
 */

/**
 * The SB slug recorded on an archived memory's metadata.
 *
 * memory_history.metadata is persisted JSONB that no migration rewrites, so
 * rows written before the agentId -> sbSlug rename carry the old key. Reading
 * only the new one makes a deleted memory's history silently disappear from
 * the scoped fallback. The sbId and workspaceId reads beside it already accept
 * both spellings for exactly this reason.
 */
export function archivedMetadataSlug(
  metadata: Record<string, unknown> | null | undefined
): string | undefined {
  return (metadata?.sbSlug as string | undefined) || (metadata?.agentId as string | undefined);
}
