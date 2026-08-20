import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../data/supabase/types';
import {
  ThreadKeyTypesRepository,
  UNKNOWN_TYPE_DEFAULT,
  type EffectiveThreadKeyType,
} from '../../data/repositories/thread-key-types.repository';
import { parseThreadKey, type ParsedThreadKey } from './parser';
import { logger } from '../../utils/logger';

/**
 * Thread-key classification — the one place a stored key becomes behavior.
 *
 * classify() = parse (grammar v2, registry-driven project recognition against
 * projects.slug) + registry resolution (override > template > unknown
 * default). Lease acquisition (Phase 6b), the route matcher (grammar
 * migration step 3), and workflow typing all consume THIS, so type behavior
 * has exactly one derivation site.
 */

export interface ThreadKeyClassification {
  parsed: ParsedThreadKey | null;
  behavior: EffectiveThreadKeyType;
}

export class ThreadKeyService {
  private registry: ThreadKeyTypesRepository;

  constructor(private supabase: SupabaseClient<Database>) {
    this.registry = new ThreadKeyTypesRepository(supabase);
  }

  /** Registered project slugs for a user. Failure → empty set (keys parse unprefixed). */
  async projectSlugs(userId: string): Promise<Set<string>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any)
      .from('projects')
      .select('slug')
      .eq('user_id', userId)
      .not('slug', 'is', null);
    if (error) {
      logger.warn('[ThreadKey] project slug lookup failed; parsing keys unprefixed', {
        userId,
        error: error.message,
      });
      return new Set();
    }
    return new Set(
      ((data as Array<{ slug: string | null }>) || [])
        .map((r) => r.slug)
        .filter((s): s is string => !!s)
    );
  }

  /**
   * Parse + resolve behavior for a thread key.
   *
   * A key that does not parse gets the conservative unknown default (write) —
   * an unparseable key must never be the cheap way to dodge the lease.
   */
  async classify(userId: string, threadKey: string): Promise<ThreadKeyClassification> {
    const slugs = await this.projectSlugs(userId);
    const parsed = parseThreadKey(threadKey, slugs);
    if (!parsed) {
      return { parsed: null, behavior: { ...UNKNOWN_TYPE_DEFAULT, type: threadKey } };
    }
    const behavior = await this.registry.getEffective(userId, parsed.type);
    return { parsed, behavior };
  }
}
