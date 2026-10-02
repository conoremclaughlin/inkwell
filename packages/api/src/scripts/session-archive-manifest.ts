/**
 * Read-only dry run for the session lifecycle cutover (task T0;
 * ink://specs/session-lifecycle-model v6 §7.2).
 *
 *   yarn workspace @inklabs/api manifest:session-archive
 *
 * Loads every session and every pointer that can keep one routable, runs the
 * classifier, prints counts only, and writes the per-row manifest to a
 * private path outside the repository (default ~/.ink/files/
 * session-archive-manifest/, or SESSION_ARCHIVE_MANIFEST_OUT). The manifest
 * names real sessions and must never be committed, pasted into a PR, or
 * quoted in a commit message. It writes nothing to the database.
 *
 * The approved manifest is evidence for the cutover, not authorization: the
 * cutover revalidates it inside the window against changes made since.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSupabaseClient } from '../data/supabase/client';
import {
  classifySessions,
  type ManifestChannelRoute,
  type ManifestIdentity,
  type ManifestLatestSender,
  type ManifestSession,
  type ManifestThreadBinding,
} from '../services/sessions/archive-manifest';

const PAGE = 1000;

type Row = Record<string, unknown>;

/** Every row of a select, page by page, in a stable order. */
async function selectAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  table: string,
  columns: string,
  orderBy: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filter: (q: any) => any = (q) => q
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await filter(client.from(table).select(columns))
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) return rows;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

async function main() {
  const client = createSupabaseClient();

  const [sessionRows, executedRows, identityRows, threadRows, bindingRows, messageRows, routeRows] =
    await Promise.all([
      selectAll(
        client,
        'sessions',
        'id, user_id, sb_id, agent_id, studio_id, contact_id, backend, backend_session_id, claude_session_id, alias, ended_at, lifecycle, status, message_count',
        'id'
      ),
      selectAll(client, 'activity_stream', 'id, session_id', 'id', (q) =>
        q.in('type', ['agent_spawn', 'agent_complete']).not('session_id', 'is', null)
      ),
      selectAll(
        client,
        'agent_identities',
        'id, user_id, workspace_id, agent_id, backend, default_session_id',
        'id'
      ),
      selectAll(client, 'inbox_threads', 'id, workspace_id', 'id'),
      selectAll(
        client,
        'inbox_thread_participants',
        'thread_id, sb_id, session_id',
        'thread_id',
        (q) => q.not('session_id', 'is', null).not('sb_id', 'is', null)
      ),
      selectAll(
        client,
        'inbox_thread_messages',
        'id, thread_id, sender_sb_id, created_at, sender_session:metadata->pcp->sender->>sessionId',
        'id',
        (q) => q.not('sender_sb_id', 'is', null)
      ),
      selectAll(client, 'channel_routes', 'id, user_id, sb_id, active_session_id, is_active', 'id'),
    ]);

  const executed = new Set(executedRows.map((r) => r.session_id as string));
  const threadWorkspace = new Map(
    threadRows.map((t) => [t.id as string, str(t.workspace_id)] as const)
  );

  const sessions: ManifestSession[] = sessionRows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    sbId: str(r.sb_id),
    sbSlug: str(r.agent_id),
    studioId: str(r.studio_id),
    contactId: str(r.contact_id),
    backend: str(r.backend),
    backendSessionId: str(r.backend_session_id),
    claudeSessionId: str(r.claude_session_id),
    sessionKey: str(r.alias),
    endedAt: str(r.ended_at),
    lifecycle: str(r.lifecycle),
    status: str(r.status),
    messageCount: typeof r.message_count === 'number' ? r.message_count : null,
    hasExecuted: executed.has(r.id as string),
  }));

  const identities: ManifestIdentity[] = identityRows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    workspaceId: str(r.workspace_id),
    slug: r.agent_id as string,
    backend: str(r.backend),
    defaultSessionId: str(r.default_session_id),
  }));

  const bindings: ManifestThreadBinding[] = bindingRows.map((r) => ({
    threadId: r.thread_id as string,
    threadWorkspaceId: threadWorkspace.get(r.thread_id as string) ?? null,
    sbId: r.sb_id as string,
    sessionId: r.session_id as string,
  }));

  // The latest message each SB sent on each thread, and the session it came from.
  const latest = new Map<string, Row>();
  for (const m of messageRows) {
    if (!str(m.sender_session)) continue;
    const key = `${m.thread_id}|${m.sender_sb_id}`;
    const prior = latest.get(key);
    if (!prior || String(m.created_at) > String(prior.created_at)) latest.set(key, m);
  }
  const latestSenders: ManifestLatestSender[] = [...latest.values()].map((m) => ({
    threadId: m.thread_id as string,
    threadWorkspaceId: threadWorkspace.get(m.thread_id as string) ?? null,
    sbId: m.sender_sb_id as string,
    sessionId: m.sender_session as string,
  }));

  const channelRoutes: ManifestChannelRoute[] = routeRows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    sbId: str(r.sb_id),
    sessionId: str(r.active_session_id),
    isActive: r.is_active === true,
  }));

  const manifest = classifySessions({
    sessions,
    identities,
    bindings,
    latestSenders,
    channelRoutes,
  });

  const out =
    process.env.SESSION_ARCHIVE_MANIFEST_OUT ||
    join(
      homedir(),
      '.ink',
      'files',
      'session-archive-manifest',
      `manifest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), ...manifest }, null, 2)}\n`,
    {
      mode: 0o600,
    }
  );

  // Counts only on stdout: the per-row manifest stays in the private file.
  console.log(JSON.stringify(manifest.counts, null, 2));
  console.log(`Manifest written (private): ${out}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
