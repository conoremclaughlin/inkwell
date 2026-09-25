/**
 * How a person is shown to another person. Messages and participant rows
 * name a person by user id (spec inkmail-thread-scope §3); a reader needs
 * a label, and needs to know which person is themselves. Both are decided
 * here, on the server, against the Inkwell user the request resolved to — a
 * client comparing against its auth provider's id would compare the wrong
 * id (Lumen, #620: the Supabase Auth UUID is not the Inkwell user id).
 */

export interface PersonDisplay {
  userId: string;
  /** Never the viewer-relative "You" — that is the reader's call, from `isOwn`. */
  name: string;
  /** The viewer themselves. */
  isOwn: boolean;
}

/** What a person is called when their profile has nothing usable. */
export const ANONYMOUS_PERSON = 'a workspace member';

interface UserNameRow {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  email?: string | null;
}

/** Full name, else username, else email, else the anonymous label. */
export function personDisplayName(row: Omit<UserNameRow, 'id'> | null | undefined): string {
  if (!row) return ANONYMOUS_PERSON;
  const full = [row.first_name, row.last_name]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');
  if (full) return full;
  const username = (row.username ?? '').trim();
  if (username) return username;
  const email = (row.email ?? '').trim();
  if (email) return email;
  return ANONYMOUS_PERSON;
}

/**
 * One batched lookup for every person a page names. Ids with no user row
 * are absent from the map; `describePeople` labels them anonymously rather
 * than dropping them — a message from a deleted account is still a message.
 */
export async function resolvePersonNames(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  userIds: Iterable<string>
): Promise<Map<string, string>> {
  const ids = [...new Set([...userIds].filter(Boolean))];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { data, error } = await client
    .from('users')
    .select('id, first_name, last_name, username, email')
    .in('id', ids);
  if (error) {
    throw new Error(`Failed to resolve people: ${error.message}`);
  }
  for (const row of (data || []) as UserNameRow[]) {
    names.set(row.id, personDisplayName(row));
  }
  return names;
}

/** Labels people for one viewer. */
export function describePeople(
  userIds: Iterable<string>,
  names: Map<string, string>,
  viewerUserId: string | null | undefined
): PersonDisplay[] {
  return [...userIds].map((userId) => ({
    userId,
    name: names.get(userId) ?? ANONYMOUS_PERSON,
    isOwn: !!viewerUserId && userId === viewerUserId,
  }));
}
