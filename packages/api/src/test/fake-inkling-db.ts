/**
 * A FakePostgrest holding the tables the inkling routes touch, with their
 * real unique constraints and a stand-in for redeem_kindle_token.
 *
 * The stand-in mirrors the function in
 * supabase/migrations/20261002082853_inkling_self_serve_awakening.sql only as
 * far as the service can observe it: the token is consumed or refused, the
 * lineage and identity are created together, a second identity for one
 * awakenRequestId rolls the whole redemption back with 23505, and a
 * self-serve awakening at p_awaken_cap fails IK001. The function
 * itself is proven against real Postgres in
 * src/data/inkling-awakening-migration.pg.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { CLIENT_MESSAGE_INDEX } from '../services/send-receipt';
import { FakePostgrest, type Row } from './fake-postgrest';

export const AWAKEN_REQUEST_INDEX = 'agent_identities_user_awaken_request_key';
export { CLIENT_MESSAGE_INDEX };

function metadataKey(row: Row, key: string): string | null {
  const value = (row.metadata as Row | null | undefined)?.[key];
  return typeof value === 'string' ? value : null;
}

export function createInklingDb(): FakePostgrest {
  const db = new FakePostgrest();
  db.unique.agent_identities = [
    {
      name: 'agent_identities_user_workspace_agent_key',
      key: (r) => `${r.user_id}|${r.workspace_id}|${r.agent_id}`,
    },
    {
      name: AWAKEN_REQUEST_INDEX,
      key: (r) => {
        const id = metadataKey(r, 'awakenRequestId');
        return id === null ? null : `${r.user_id}|${id}`;
      },
    },
  ];
  db.unique.kindle_tokens = [{ name: 'kindle_tokens_token_key', key: (r) => String(r.token) }];
  db.unique.inbox_thread_messages = [
    {
      name: CLIENT_MESSAGE_INDEX,
      key: (r) => {
        const id = metadataKey(r, 'clientMessageId');
        return id === null ? null : `${r.thread_id}|${id}`;
      },
    },
  ];

  let tokenCounter = 0;
  const originalFrom = db.from.bind(db);
  // The token column's server-side default.
  db.from = (table: string) => {
    const query = originalFrom(table);
    if (table !== 'kindle_tokens') return query;
    const insert = query.insert.bind(query);
    query.insert = (values: Row | Row[]) =>
      insert(
        (Array.isArray(values) ? values : [values]).map((v) => ({
          status: 'active',
          token: `token-${++tokenCounter}`,
          ...v,
        }))
      );
    return query;
  };

  db.rpcHandlers.redeem_kindle_token = (args) => {
    const method = (args.p_kindle_method as string | undefined) ?? 'referral';
    const token = db
      .rows('kindle_tokens')
      .find((t) => t.token === args.p_token && t.status === 'active');
    if (!token) {
      return { data: null, error: { message: 'kindle token is not redeemable' } };
    }
    if (
      method === 'self_serve' &&
      (token.creator_agent_id !== null || token.creator_user_id !== args.p_new_user_id)
    ) {
      return { data: null, error: { message: 'own parentless token only' } };
    }

    const selfServe = method === 'self_serve';
    const cap = args.p_awaken_cap as number | null | undefined;
    if (selfServe && typeof cap === 'number') {
      const awakened = db
        .rows('kindle_lineage')
        .filter((l) => l.child_user_id === args.p_new_user_id && l.kindle_method === 'self_serve');
      if (awakened.length >= cap) {
        // Raised before anything is written, so the token stays active.
        return {
          data: null,
          error: { code: 'IK001', message: 'inkling awakening cap reached' },
        };
      }
    }
    const slug = `kindle-${token.id as string}`;
    const identityInput = args.p_identity as Row;
    const lineage: Row = {
      id: randomUUID(),
      parent_agent_id: token.creator_agent_id,
      parent_user_id: selfServe ? null : token.creator_user_id,
      facilitator_user_id: token.creator_user_id,
      child_agent_id: slug,
      child_user_id: args.p_new_user_id,
      kindle_method: method,
      onboarding_status: selfServe ? 'complete' : 'values_interview',
      completed_at: selfServe ? db.now() : null,
      chosen_name: null,
      created_at: db.now(),
    };
    const at = db.now();
    const identity: Row = {
      id: randomUUID(),
      user_id: args.p_new_user_id,
      workspace_id: args.p_workspace_id,
      agent_id: slug,
      name: identityInput.name ?? 'New SB',
      role: identityInput.role ?? 'Nascent SB in onboarding',
      soul: identityInput.soul ?? null,
      metadata: {
        ...((identityInput.metadata as Row | undefined) ?? {}),
        kindleId: lineage.id,
        onboarding: !selfServe,
      },
      created_at: at,
      updated_at: at,
    };
    const violated = db.violation('agent_identities', identity);
    if (violated) {
      // The whole redemption rolls back: the token stays active, nothing is written.
      return {
        data: null,
        error: {
          code: '23505',
          message: `duplicate key value violates unique constraint "${violated.name}"`,
        },
      };
    }
    token.status = 'used';
    token.used_by_user_id = args.p_new_user_id;
    db.rows('agent_identities').push(identity);
    lineage.child_sb_id = identity.id;
    db.rows('kindle_lineage').push(lineage);
    return { data: { ...lineage }, error: null };
  };

  return db;
}

/** An SB that was not born through the Inkling flow, as Myra or Wren are. */
export function seedOwnSb(
  db: FakePostgrest,
  scope: { userId: string; workspaceId: string },
  slug: string
): Row {
  return db.seed('agent_identities', {
    user_id: scope.userId,
    workspace_id: scope.workspaceId,
    agent_id: slug,
    name: slug[0].toUpperCase() + slug.slice(1),
    role: 'Personal SB',
    metadata: {},
  });
}
