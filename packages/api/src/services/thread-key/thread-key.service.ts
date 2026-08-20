import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../data/supabase/types';
import {
  ThreadKeyTypesRepository,
  UNKNOWN_TYPE_DEFAULT,
  type EffectiveThreadKeyType,
} from '../../data/repositories/thread-key-types.repository';

/**
 * Thread-key behavior resolution.
 *
 * There is deliberately NO classify(rawKey) here (Lumen, PR #516 round 2):
 * an API that parses a raw stored key invites every consumer to live-re-parse
 * against today's slug registry, which is exactly the reinterpretation the
 * pinned identity exists to prevent. Stored threads carry their identity in
 * inbox_threads.key_project/key_type/key_id — pinned by the DB trigger
 * pin_thread_key_before_insert at creation, immutable after. Consumers
 * resolve behavior from the STORED type via typeBehavior().
 *
 * The TS parser (./parser) remains for the two legitimate non-stored uses:
 * route-PATTERN parsing (patterns are configuration, not identity) and
 * tooling. An integration parity test guards TS↔SQL parser drift.
 */
export class ThreadKeyService {
  private registry: ThreadKeyTypesRepository;

  constructor(private supabase: SupabaseClient<Database>) {
    this.registry = new ThreadKeyTypesRepository(supabase);
  }

  /**
   * Registered project slugs for a user — for PATTERN parsing and tooling
   * only, never for re-parsing a stored key.
   *
   * FAILS CLOSED (Lumen, PR #516 round 2 condition 1): a lookup error throws
   * rather than returning an empty set. The empty-set fallback made
   * `pcp:issue:x` parse as (null, 'pcp', 'issue:x') — a wrong identity that
   * callers might then act on. No caller may treat "could not read the
   * registry" as "there are no projects".
   */
  async projectSlugs(userId: string): Promise<Set<string>> {
    const { data, error } = await this.supabase
      .from('projects')
      .select('slug')
      .eq('user_id', userId)
      .not('slug', 'is', null);
    if (error) {
      throw new Error(`Project slug lookup failed: ${error.message}`);
    }
    return new Set((data || []).map((r) => r.slug).filter((s): s is string => !!s));
  }

  /**
   * Behavior for a STORED key type (inbox_threads.key_type). This is the
   * single entry point Phase 6b consumes. An untyped thread (key_type NULL)
   * gets the conservative unknown default — write.
   */
  async typeBehavior(
    userId: string,
    storedKeyType: string | null
  ): Promise<EffectiveThreadKeyType> {
    if (!storedKeyType) {
      return { ...UNKNOWN_TYPE_DEFAULT, type: '' };
    }
    return this.registry.getEffective(userId, storedKeyType);
  }
}
