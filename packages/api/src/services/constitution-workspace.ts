/**
 * The workspace whose shared documents an identity is given: the values, the
 * process, and the person's page about themselves (`user_identity`).
 *
 * One rule for every SB, read by bootstrap and by context-builder alike: the
 * identity's own workspace, and only when it has none, the person's oldest
 * personal workspace. Bootstrap used to skip the first step, so an identity
 * living in any other workspace was handed the oldest personal workspace's
 * process and the person's page from there, while context-builder gave the
 * same identity its own (thread:inkling-starter-space, Oct 7 2026).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

export async function constitutionWorkspaceId(
  client: Client,
  userId: string,
  identityWorkspaceId: string | null | undefined
): Promise<string | undefined> {
  if (identityWorkspaceId) return identityWorkspaceId;

  const { data: personalWorkspace } = await client
    .from('workspaces')
    .select('id')
    .eq('user_id', userId)
    .eq('type', 'personal')
    .is('archived_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (personalWorkspace?.id as string | undefined) || undefined;
}
