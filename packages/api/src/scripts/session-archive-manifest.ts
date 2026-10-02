/**
 * Read-only dry run for the session lifecycle cutover (task T0;
 * ink://specs/session-lifecycle-model v6 §7.2).
 *
 *   yarn workspace @inklabs/api manifest:session-archive
 *
 * Loads every session and every pointer that can keep one routable, runs the
 * classifier, prints counts only, and writes the per-row manifest to a
 * private path outside any checkout (default ~/.ink/files/
 * session-archive-manifest/, or SESSION_ARCHIVE_MANIFEST_OUT). The manifest
 * names real sessions and must never be committed, pasted into a PR, or
 * quoted in a commit message. It writes nothing to the database.
 *
 * The approved manifest is evidence for the cutover, not authorization: the
 * cutover revalidates it inside the window against changes made since.
 */
import { lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createSupabaseClient } from '../data/supabase/client';
import {
  classifySessions,
  type ManifestChannelRoute,
  type ManifestIdentity,
  type ManifestLatestSender,
  type ManifestSession,
  type ManifestStudio,
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

/** The nearest directory at or above `dir` that holds a `.git` entry, if any. */
function enclosingCheckout(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The physical path of the nearest ancestor of `p` that exists. */
async function realAncestor(p: string): Promise<string> {
  let current = resolve(p);
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Write the manifest only where it stays private: never inside a git
 * checkout, never through a symlink, always mode 0600. Every check runs on
 * the physical location as well as the spelled one, because a symlinked
 * parent can lead into a checkout while every spelled ancestor looks clean.
 * An existing regular file is replaced, not rewritten in place, so its old
 * mode cannot survive; exclusive creation refuses anything that appears at
 * the path in between.
 */
export async function writePrivateManifest(out: string, contents: string): Promise<void> {
  const spelled = resolve(out);
  const refuseCheckout = (dir: string) => {
    const checkout = enclosingCheckout(dir);
    if (checkout) {
      throw new Error(`Refusing to write the manifest inside a git checkout (${checkout})`);
    }
  };
  refuseCheckout(dirname(spelled));
  refuseCheckout(await realAncestor(dirname(spelled)));
  await mkdir(dirname(spelled), { recursive: true, mode: 0o700 });
  const physicalDir = await realpath(dirname(spelled));
  refuseCheckout(physicalDir);

  const target = join(physicalDir, basename(spelled));
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new Error('Refusing to write the manifest through a symlink');
  }
  if (existing && !existing.isFile()) {
    throw new Error('Refusing to write the manifest over something that is not a regular file');
  }
  if (existing) await unlink(target);
  await writeFile(target, contents, { flag: 'wx', mode: 0o600 });
}

async function main() {
  const client = createSupabaseClient();

  const [
    sessionRows,
    activityRows,
    identityRows,
    threadRows,
    projectRows,
    studioRows,
    bindingRows,
    messageRows,
    routeRows,
  ] = await Promise.all([
    selectAll(
      client,
      'sessions',
      'id, user_id, sb_id, agent_id, studio_id, contact_id, backend, backend_session_id, claude_session_id, alias, ended_at, lifecycle, status, message_count, token_count, started_at, working_dir, cli_turn_at, cli_turn_stopped_at',
      'id'
    ),
    // Any activity row is evidence the session ran: a turn, a tool call.
    selectAll(client, 'activity_stream', 'id, session_id, created_at', 'id', (q) =>
      q.not('session_id', 'is', null)
    ),
    selectAll(
      client,
      'agent_identities',
      'id, user_id, workspace_id, agent_id, backend, default_session_id',
      'id'
    ),
    selectAll(client, 'inbox_threads', 'id, workspace_id, key_project, thread_key', 'id'),
    selectAll(client, 'projects', 'id, slug, repo_root, workspace_id', 'id'),
    selectAll(
      client,
      'studios',
      'id, user_id, sb_id, repo_root, worktree_path, status, archived_at, cleaned_at, ephemeral, thread_key, parent_studio_id',
      'id'
    ),
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

  // Positive evidence that a session ran or spoke: an activity row, a CLI
  // turn boundary, recorded token usage, or an inbox message it authored.
  const evidence = new Set(activityRows.map((r) => r.session_id as string));

  for (const m of messageRows) {
    const authored = str(m.sender_session);
    if (authored) evidence.add(authored);
  }
  for (const r of sessionRows) {
    const usedTokens = typeof r.token_count === 'number' && r.token_count > 0;
    if (str(r.cli_turn_at) || str(r.cli_turn_stopped_at) || usedTokens) {
      evidence.add(r.id as string);
    }
  }

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
    startedAt: str(r.started_at),
    workingDir: str(r.working_dir),
    hasExecuted: evidence.has(r.id as string),
  }));

  const identities: ManifestIdentity[] = identityRows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    workspaceId: str(r.workspace_id),
    slug: r.agent_id as string,
    backend: str(r.backend),
    defaultSessionId: str(r.default_session_id),
  }));

  const studios: ManifestStudio[] = studioRows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    sbId: str(r.sb_id),
    repoRoot: str(r.repo_root),
    worktreePath: str(r.worktree_path),
    ephemeral: r.ephemeral === true,
    threadKey: str(r.thread_key),
    parentStudioId: str(r.parent_studio_id),
    closed: r.status === 'cleaned' || !!str(r.archived_at) || !!str(r.cleaned_at),
  }));

  // A pinned thread's project, by slug inside the thread's workspace.
  const projectRoot = new Map(
    projectRows
      .filter((p) => str(p.slug))
      .map((p) => [`${str(p.workspace_id)}|${p.slug}`, str(p.repo_root)] as const)
  );
  const threadInfo = new Map(
    threadRows.map((t) => {
      const workspaceId = str(t.workspace_id);
      const pin = str(t.key_project);
      return [
        t.id as string,
        {
          workspaceId,
          threadKey: str(t.thread_key),
          // Undefined: not pinned. Null: pinned to a project with no known root.
          projectRepoRoot: pin ? (projectRoot.get(`${workspaceId}|${pin}`) ?? null) : undefined,
        },
      ] as const;
    })
  );
  const threadFields = (threadId: string) => {
    const info = threadInfo.get(threadId);
    return {
      threadWorkspaceId: info?.workspaceId ?? null,
      threadKey: info?.threadKey ?? null,
      ...(info && info.projectRepoRoot !== undefined
        ? { threadProjectRepoRoot: info.projectRepoRoot }
        : {}),
    };
  };

  const bindings: ManifestThreadBinding[] = bindingRows.map((r) => ({
    threadId: r.thread_id as string,
    sbId: r.sb_id as string,
    sessionId: r.session_id as string,
    ...threadFields(r.thread_id as string),
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
    sbId: m.sender_sb_id as string,
    sessionId: m.sender_session as string,
    ...threadFields(m.thread_id as string),
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
    studios,
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
  await writePrivateManifest(
    out,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), ...manifest }, null, 2)}\n`
  );

  // Counts only on stdout: the per-row manifest stays in the private file.
  console.log(JSON.stringify(manifest.counts, null, 2));
  console.log(`Manifest written (private): ${out}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
