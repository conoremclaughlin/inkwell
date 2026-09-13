/**
 * Which sessions, studios, and task groups belong on a workspace's thread
 * page. Since the cutover those carriers name their SB by identity
 * (`sb_id`), and an identity lives in exactly one workspace (spec
 * inkmail-thread-scope §1, §3) — so the workspace's identities are the
 * scope, not the viewer's user id, which attached a same-key session from
 * another workspace to this one's conversation (Lumen, #621). A legacy row
 * with no identity is still the viewer's own, as before.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

/** Every identity in the workspace. */
export async function workspaceSbIds(client: Client, workspaceId: string): Promise<string[]> {
  const { data, error } = await client
    .from('agent_identities')
    .select('id')
    .eq('workspace_id', workspaceId);
  if (error) {
    throw new Error(`Failed to list the workspace's identities: ${error.message}`);
  }
  return ((data || []) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * A PostgREST `or` filter: rows attributed to one of the workspace's
 * identities, or unattributed rows of the viewer.
 */
export function carrierScopeFilter(sbIds: string[], legacyOwnerUserId: string): string {
  const own = `and(sb_id.is.null,user_id.eq.${legacyOwnerUserId})`;
  if (sbIds.length === 0) return own;
  return `sb_id.in.(${sbIds.join(',')}),${own}`;
}
