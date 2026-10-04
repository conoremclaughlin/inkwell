/**
 * thread_message_reactions on a FakePostgrest, mirroring
 * supabase/migrations/20261004095944_thread_message_reactions.sql only as
 * far as the service can observe it: the unique index refuses a second
 * (message, reactor, emoji) with 23505, an insert for a message that is gone
 * fails 23503, a thread or workspace that is not the message's fails 23514,
 * and a seventh distinct emoji from one reactor on one message fails with
 * the guard trigger's token. The trigger itself, its lock under concurrency
 * and the cascades are proven against real Postgres in
 * thread-reactions.integration.test.ts.
 */

import { REACTION_LIMIT_TOKEN, REACTIONS_TABLE } from '../services/threads/thread-reactions';
import type { FakePostgrest, FakeResult, Row } from './fake-postgrest';

export const REACTIONS_UNIQUE_INDEX = 'thread_message_reactions_message_reactor_emoji_key';

const reactorOf = (row: Row): unknown => row.reactor_user_id ?? row.reactor_sb_id;

function refused(code: string, message: string): PromiseLike<FakeResult> {
  return Promise.resolve({ data: null, error: { code, message } });
}

/** Adds the reactions table's constraints and guard trigger to `db`. */
export function withReactionsTable(db: FakePostgrest): FakePostgrest {
  db.unique[REACTIONS_TABLE] = [
    {
      name: REACTIONS_UNIQUE_INDEX,
      key: (r) => `${String(r.message_id)}|${String(reactorOf(r))}|${String(r.emoji)}`,
    },
  ];
  const originalFrom = db.from.bind(db);
  db.from = (table: string) => {
    const query = originalFrom(table);
    if (table !== REACTIONS_TABLE) return query;
    const insert = query.insert.bind(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (query as any).insert = (values: Row) => {
      const message = db.rows('inbox_thread_messages').find((m) => m.id === values.message_id);
      if (!message) return refused('23503', 'message does not exist');
      const thread = db.rows('inbox_threads').find((t) => t.id === message.thread_id);
      if (values.thread_id !== message.thread_id || values.workspace_id !== thread?.workspace_id) {
        return refused('23514', "a reaction's thread and workspace must be its message's");
      }
      const others = db
        .rows(REACTIONS_TABLE)
        .filter(
          (r) =>
            r.message_id === values.message_id &&
            reactorOf(r) === reactorOf(values) &&
            r.emoji !== values.emoji
        );
      if (others.length >= 6) {
        return refused('23514', `${REACTION_LIMIT_TOKEN}: at most 6 reactions per reactor`);
      }
      return insert(values);
    };
    return query;
  };
  return db;
}
