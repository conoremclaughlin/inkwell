import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import { BaseRepository } from './base.repository';

/**
 * Thread-key type registry (spec: ink://specs/thread-key-grammar v2).
 *
 * The registry is DATA, not a code constant (Conor, 2026-08-20): general
 * rules like "pr:* creates a studio" are user-adjustable without a deploy,
 * and system template rows (user_id IS NULL) ship working defaults.
 *
 * Resolution: a user override row beats the template row for the same type;
 * no row at all resolves to the unknown-type default. Behavior lives HERE,
 * never in call sites (grammar v2 invariant 5) — no consumer hardcodes
 * "spec means presence".
 */

export type WriteIntent = 'write' | 'presence';
export type StudioPolicy = 'provision' | 'reuse-only';

export interface ThreadKeyType {
  id: string;
  userId: string | null;
  type: string;
  writeIntent: WriteIntent;
  studioPolicy: StudioPolicy;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EffectiveThreadKeyType {
  type: string;
  writeIntent: WriteIntent;
  studioPolicy: StudioPolicy;
  description: string | null;
  /** Where this behavior came from: user override, shipped template, or the unknown-type default. */
  source: 'override' | 'template' | 'default';
}

/**
 * Unknown/unregistered types default to write + reuse-only.
 *
 * `write` is v1 ROLLOUT SAFETY, not the end state: until escalation-on-write
 * detection ships (Phase 6e), a wrongly-presence session that edits files
 * would mutate an unleased tree. Once escalation exists this flips to
 * presence, with escalation as the net (grammar v2 §templates).
 */
export const UNKNOWN_TYPE_DEFAULT: EffectiveThreadKeyType = {
  type: '',
  writeIntent: 'write',
  studioPolicy: 'reuse-only',
  description: 'Unregistered type — conservative default until escalation-on-write ships',
  source: 'default',
};

export class ThreadKeyTypesRepository extends BaseRepository {
  constructor(client: SupabaseClient<Database>) {
    super(client);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapRow(row: Record<string, any>): ThreadKeyType {
    return {
      id: row.id,
      userId: row.user_id ?? null,
      type: row.type,
      writeIntent: row.write_intent,
      studioPolicy: row.studio_policy,
      description: row.description ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** All rows visible to this user: system templates + their overrides. */
  async listForUser(userId: string): Promise<ThreadKeyType[]> {
    try {
      const { data, error } = await this.client
        .from('thread_key_types')
        .select('*')
        .or(`user_id.is.null,user_id.eq.${userId}`)
        .order('type');
      if (error) throw error;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((data as any[]) || []).map((r) => this.mapRow(r));
    } catch (error) {
      this.handleError(error, 'listForUser');
    }
  }

  /** Effective view: overrides shadow templates, keyed by type. */
  async listEffective(userId: string): Promise<EffectiveThreadKeyType[]> {
    const rows = await this.listForUser(userId);
    const byType = new Map<string, EffectiveThreadKeyType>();
    // Templates first, then overrides shadow them.
    for (const row of rows.filter((r) => r.userId === null)) {
      byType.set(row.type, {
        type: row.type,
        writeIntent: row.writeIntent,
        studioPolicy: row.studioPolicy,
        description: row.description,
        source: 'template',
      });
    }
    for (const row of rows.filter((r) => r.userId !== null)) {
      byType.set(row.type, {
        type: row.type,
        writeIntent: row.writeIntent,
        studioPolicy: row.studioPolicy,
        description: row.description,
        source: 'override',
      });
    }
    return [...byType.values()].sort((a, b) => a.type.localeCompare(b.type));
  }

  /**
   * Effective behavior for one type. NEVER throws on lookup problems in a way
   * that callers could confuse with presence — a registry read failure
   * surfaces as the conservative unknown-type default (write), because
   * failing toward presence would let a session mutate an unleased tree.
   */
  async getEffective(userId: string, type: string): Promise<EffectiveThreadKeyType> {
    try {
      const rows = await this.listForUser(userId);
      const override = rows.find((r) => r.userId !== null && r.type === type);
      if (override) {
        return {
          type: override.type,
          writeIntent: override.writeIntent,
          studioPolicy: override.studioPolicy,
          description: override.description,
          source: 'override',
        };
      }
      const template = rows.find((r) => r.userId === null && r.type === type);
      if (template) {
        return {
          type: template.type,
          writeIntent: template.writeIntent,
          studioPolicy: template.studioPolicy,
          description: template.description,
          source: 'template',
        };
      }
      return { ...UNKNOWN_TYPE_DEFAULT, type };
    } catch {
      return { ...UNKNOWN_TYPE_DEFAULT, type };
    }
  }

  /** Upsert a user override. */
  async setOverride(
    userId: string,
    type: string,
    values: { writeIntent: WriteIntent; studioPolicy: StudioPolicy; description?: string | null }
  ): Promise<ThreadKeyType> {
    try {
      const { data: existing, error: findErr } = await this.client
        .from('thread_key_types')
        .select('id')
        .eq('user_id', userId)
        .eq('type', type)
        .maybeSingle();
      if (findErr) throw findErr;

      if (existing?.id) {
        const { data, error } = await this.client
          .from('thread_key_types')
          .update({
            write_intent: values.writeIntent,
            studio_policy: values.studioPolicy,
            // Undefined means "not provided", null means "clear" (upsert safety).
            ...(values.description !== undefined ? { description: values.description } : {}),
          } as never)
          .eq('id', existing.id)
          .select()
          .single();
        if (error) throw error;
        return this.mapRow(data as Record<string, unknown>);
      }

      const { data, error } = await this.client
        .from('thread_key_types')
        .insert({
          user_id: userId,
          type,
          write_intent: values.writeIntent,
          studio_policy: values.studioPolicy,
          description: values.description ?? null,
        } as never)
        .select()
        .single();
      if (error) throw error;
      return this.mapRow(data as Record<string, unknown>);
    } catch (error) {
      this.handleError(error, 'setOverride');
    }
  }

  /** Delete a user override; the shipped template (or default) resumes. */
  async clearOverride(userId: string, type: string): Promise<boolean> {
    try {
      const { data, error } = await this.client
        .from('thread_key_types')
        .delete()
        .eq('user_id', userId)
        .eq('type', type)
        .select('id');
      if (error) throw error;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((data as any[]) || []).length > 0;
    } catch (error) {
      this.handleError(error, 'clearOverride');
    }
  }
}
