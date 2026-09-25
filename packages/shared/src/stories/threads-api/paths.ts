/**
 * Where the threads API lives. Every client builds its requests here, so a
 * change to a route or a query parameter is one edit rather than one per app.
 */

/** GET: every thread the viewer can see, as spines, newest activity first. */
export const THREADS_PATH = '/api/admin/threads';

/**
 * GET: a thread's newest page of messages, or — with `beforeId` — the page
 * of messages older than that one, in the server's (created_at, id) order.
 */
export function threadMessagesPath(threadKey: string, beforeId?: string): string {
  const before = beforeId ? `&before=${encodeURIComponent(beforeId)}` : '';
  return `/api/admin/threads/messages?key=${encodeURIComponent(threadKey)}${before}`;
}
