/**
 * In-process mutual exclusion by key. `withKeyedLock(key, fn)` runs `fn`
 * only after every earlier holder of the same key has finished, whether it
 * resolved or threw. Different keys never wait on each other.
 *
 * Why it exists: `git worktree add` takes repository-level locks
 * (`index.lock`, `.git/worktrees/<name>/`), so two concurrent adds in the
 * same repository fail each other — "Another git process seems to be
 * running in this repository". Two concurrent overflow ensures for one
 * thread do exactly that (CI, 2026-09-11: the race loser burned all three
 * slug candidates on git lock errors and returned null). Serializing the git
 * step per repository lets the loser reach the row insert, lose the unique
 * index there, and converge on the winner as designed.
 *
 * Scope is one process. That is where concurrent ensures originate (one
 * server); cross-process contention is still reported by git and handled by
 * the caller's fallback.
 */
const chains = new Map<string, Promise<void>>();

export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The chain never rejects: a holder's failure is its own caller's business.
  const mine = previous.then(() => held);
  chains.set(key, mine);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(key) === mine) chains.delete(key);
  }
}

/** Test seam: how many keys currently have a holder or waiters. */
export function keyedLockCount(): number {
  return chains.size;
}
