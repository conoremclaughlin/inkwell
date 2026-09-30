import { createHash } from 'node:crypto';

/**
 * Content-addressed reference for an entry — used by persistent eviction
 * (context_evict transcript events) to identify entries across reattach.
 * Stable as long as the role + stored content are reproduced identically
 * by hydration (they are — ledger transformations are deterministic).
 */
export function entryRefHash(role: string, content: string): string {
  return 'sha1:' + createHash('sha1').update(`${role}|${content}`).digest('hex').slice(0, 16);
}
