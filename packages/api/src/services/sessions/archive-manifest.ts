/**
 * Dry-run classification for the session lifecycle cutover
 * (ink://specs/session-lifecycle-model v6 §7.2, task T0).
 *
 * Read-only and pure: callers load the rows, this decides what the cutover
 * would do with each one, and nothing here writes. The live manifest it
 * produces names real sessions and stays private; only this classifier and
 * invented fixtures are repository material.
 *
 * The question it answers: once `ended_at` stops being a routing fence, which
 * of today's ended sessions must stay automatically routable, and which can
 * be archived? A session stays routable when something validly points at it:
 * the binding a thread holds for an SB, the latest message an SB sent on a
 * thread that has no binding for it, an identity's home, an active channel
 * route, or its own session key when nothing else holds the same key. A
 * pointer that fails validation is reported with the evidence and never
 * preserves anything, because a stale pointer is how the 2026-08-05 drift
 * started.
 *
 * Uncertainty is never resolved toward a final decision (Lumen, review of PR
 * #720). A row is `empty` only on proof, not for lack of evidence. A
 * transcript whose studio was cleaned is a recovery question, not an archive
 * decision: studio cleanup is not transcript abandonment.
 */
import { posix } from 'node:path';

export interface ManifestSession {
  id: string;
  userId: string;
  sbId: string | null;
  sbSlug: string | null;
  studioId: string | null;
  contactId: string | null;
  backend: string | null;
  backendSessionId: string | null;
  claudeSessionId: string | null;
  sessionKey: string | null;
  endedAt: string | null;
  lifecycle: string | null;
  status: string | null;
  /** The counter the server keeps; null means unknown, not zero. */
  messageCount: number | null;
  startedAt?: string | null;
  /** Working directory the session last reported, when it has no studio. */
  workingDir?: string | null;
  /**
   * Positive evidence that the session ran or spoke: any activity row for it
   * (a turn, a tool call), a CLI turn boundary, or an inbox message it
   * authored.
   */
  hasExecuted: boolean;
}

export interface ManifestIdentity {
  id: string;
  userId: string;
  workspaceId: string | null;
  slug: string;
  backend: string | null;
  defaultSessionId: string | null;
}

export interface ManifestStudio {
  id: string;
  userId: string;
  sbId: string | null;
  repoRoot: string | null;
  /** The studio's checkout, used to place a session that reports only a working directory. */
  worktreePath?: string | null;
  /** Archived, cleaned or closed: a session can no longer resume in place. */
  closed: boolean;
  /** A thread-scoped temporary studio; the revival path can bring it back for its thread. */
  ephemeral?: boolean;
  threadKey?: string | null;
}

/** Threads are workspace-scoped; a pointer is valid only inside its SB's workspace. */
export interface ManifestThreadBinding {
  threadId: string;
  threadWorkspaceId: string | null;
  /** The thread's key, which a cleaned ephemeral studio's revival must match. */
  threadKey?: string | null;
  sbId: string;
  sessionId: string;
  /**
   * For a project-pinned thread, the project's repository root, or null when
   * the pin cannot be resolved. Undefined when the thread is not pinned.
   */
  threadProjectRepoRoot?: string | null;
}

export type ManifestLatestSender = ManifestThreadBinding;

export interface ManifestChannelRoute {
  id: string;
  userId: string;
  sbId: string | null;
  sessionId: string | null;
  isActive: boolean;
}

export type ReferenceKind = 'binding' | 'latest-sender' | 'home' | 'channel-route' | 'session-key';

export type InvalidReason =
  | 'missing-session'
  | 'unknown-identity'
  | 'workspace-unknown'
  | 'workspace-mismatch'
  | 'user-mismatch'
  | 'identity-mismatch'
  | 'legacy-identity-unresolved'
  | 'legacy-identity-ambiguous'
  | 'backend-unsupported'
  | 'backend-mismatch'
  | 'contact-scope'
  | 'studio-missing'
  | 'studio-foreign'
  | 'project-mismatch'
  | 'project-unverifiable'
  | 'empty-target';

export interface ManifestInput {
  sessions: ManifestSession[];
  identities: ManifestIdentity[];
  bindings: ManifestThreadBinding[];
  latestSenders: ManifestLatestSender[];
  channelRoutes: ManifestChannelRoute[];
  /** Optional so callers that do not load studios still classify; unknown studios then fail. */
  studios?: ManifestStudio[];
  /**
   * The earliest activity-log record. A row started before it cannot be
   * proven empty, because the log that would show its activity did not exist.
   */
  evidenceSince?: string | null;
}

/** Expected versus observed, kept in the private manifest so causes can be told apart. */
export type InvalidDetail = Record<string, string | null>;

export interface ArchiveManifest {
  counts: {
    sessions: number;
    live: number;
    ended: number;
    preserved: number;
    preservedNeedingRecovery: number;
    unresolved: number;
    archiveBackfill: number;
    archiveEmpty: number;
    invalidReferences: number;
    keyCollisionGroups: number;
    keyCollisionRows: number;
    duplicateBackendIdentities: number;
  };
  /**
   * Ended sessions that stay routable, with every valid reference that keeps
   * them. `requires: ['studio-recovery']` marks a transcript whose studio was
   * cleaned but can be revived; the cutover revives before it routes.
   */
  preserved: Array<{
    sessionId: string;
    references: ReferenceKind[];
    requires?: ['studio-recovery'];
  }>;
  /**
   * Neither routable nor archivable on the evidence: a validated pointer
   * names the transcript, but its cleaned studio cannot be shown recoverable.
   * The cutover decides these explicitly; nothing archives them by default.
   */
  unresolved: Array<{
    sessionId: string;
    reason: 'studio-recovery-unproven';
    references: ReferenceKind[];
  }>;
  /** Final archive decisions only. */
  archive: Array<{ sessionId: string; reason: 'backfill' | 'empty' }>;
  invalidReferences: Array<{
    kind: ReferenceKind;
    ref: string;
    sessionId: string;
    reason: InvalidReason;
    detail: InvalidDetail;
  }>;
  /**
   * Session-key conflicts the cutover must resolve. `index`: rows that stay
   * routable would violate the key's unique index. `unresolved`: two or more
   * ended rows held the same key with no live holder and none of them stays
   * routable, so the mapping archives every holder and nobody keeps the key;
   * someone must decide which one should.
   */
  keyCollisions: Array<{
    kind: 'index' | 'unresolved';
    scope: string;
    key: string;
    sessionIds: string[];
  }>;
  /** One backend conversation carried by more than one row of one owner and identity. */
  duplicateBackendIdentities: Array<{
    scope: string;
    backendSessionId: string;
    sessionIds: string[];
  }>;
}

/** The terminal markers the cutover retires (spec §2). */
export function isEnded(s: ManifestSession): boolean {
  return (
    s.endedAt !== null ||
    s.lifecycle === 'completed' ||
    s.status === 'completed' ||
    (s.status?.startsWith('completed:') ?? false)
  );
}

/**
 * Proven never to have held a conversation: the server's counter reads zero
 * (unknown is not zero), there is no transcript link, nothing shows the
 * session ran or spoke, and, when the caller knows when the activity log
 * began, the row is younger than the log that would have recorded it.
 */
export function isEmpty(s: ManifestSession, evidenceSince?: string | null): boolean {
  if (s.messageCount !== 0) return false;
  if (s.hasExecuted || s.backendSessionId || s.claudeSessionId) return false;
  if (evidenceSince !== undefined) {
    if (!evidenceSince || !s.startedAt || s.startedAt < evidenceSince) return false;
  }
  return true;
}

export type RuntimeName = 'claude-code' | 'codex-cli' | 'gemini' | 'antigravity' | 'ink';

/**
 * The runtimes a session can resume on, with the spellings the server
 * accepts for each (session-service normalizeBackend). Unlike the server,
 * which falls back to claude-code for an unknown name, admission refuses it.
 */
const RUNTIME_SPELLINGS: Record<RuntimeName, readonly string[]> = {
  'claude-code': ['claude', 'claude-code'],
  'codex-cli': ['codex', 'codex-cli'],
  gemini: ['gemini', 'gemini-cli'],
  antigravity: ['antigravity', 'antigravity-cli', 'agy'],
  ink: ['ink', 'direct-api', 'direct', 'api'],
};

export function normalizeRuntime(raw: string | null): RuntimeName | null {
  const value = (raw ?? '').toLowerCase().trim();
  if (!value) return null;
  for (const [runtime, spellings] of Object.entries(RUNTIME_SPELLINGS)) {
    if (spellings.includes(value)) return runtime as RuntimeName;
  }
  return null;
}

/** Two spellings of one supported runtime. Unknown names never match, even each other. */
export function sameBackend(a: string | null, b: string | null): boolean {
  const left = normalizeRuntime(a);
  return left !== null && left === normalizeRuntime(b);
}

/**
 * The scope of the session-key unique index, `idx_sessions_alias_unique`:
 * user, agent slug, studio. Keys compare lowercased, the way #717's lookup
 * reads them, so two spellings of one key count as one.
 */
function keyScope(s: ManifestSession): string {
  return `${s.userId}|${s.sbSlug ?? s.sbId ?? '?'}|${s.studioId ?? '-'}`;
}

/** Path containment by segments after normalisation, so `/a/../b` is not under `/a`. */
export function underRoot(path: string, root: string): boolean {
  const rel = posix.relative(posix.normalize(root), posix.normalize(path));
  return rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel));
}

/** How a pointer must treat the session's runtime. */
type BackendRule =
  | { kind: 'supported' }
  | { kind: 'equal'; backend: string | null }
  | { kind: 'none' };

export function classifySessions(input: ManifestInput): ArchiveManifest {
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  const identityById = new Map(input.identities.map((i) => [i.id, i]));
  const studioById = new Map((input.studios ?? []).map((s) => [s.id, s]));
  const empty = (s: ManifestSession) => isEmpty(s, input.evidenceSince);
  const references = new Map<string, Set<ReferenceKind>>();
  const recoverable = new Map<string, Set<ReferenceKind>>();
  const unrecoverable = new Map<string, Set<ReferenceKind>>();
  const invalid: ArchiveManifest['invalidReferences'] = [];

  const add = (map: Map<string, Set<ReferenceKind>>, sessionId: string, kind: ReferenceKind) => {
    const set = map.get(sessionId) ?? new Set<ReferenceKind>();
    set.add(kind);
    map.set(sessionId, set);
  };

  /**
   * The canonical identity a row belongs to. A row with an sb_id names it; a
   * legacy row with only a slug resolves when exactly one identity of the
   * same owner carries that slug, and never otherwise.
   */
  const resolveIdentity = (
    s: ManifestSession
  ):
    | { id: string }
    | { unresolved: 'legacy-identity-unresolved' | 'legacy-identity-ambiguous' } => {
    if (s.sbId) return { id: s.sbId };
    const candidates = input.identities.filter(
      (i) => i.userId === s.userId && s.sbSlug !== null && i.slug === s.sbSlug
    );
    if (candidates.length === 1) return { id: candidates[0].id };
    return {
      unresolved:
        candidates.length === 0 ? 'legacy-identity-unresolved' : 'legacy-identity-ambiguous',
    };
  };

  /** A studio counts as the session's only when it is the same owner's and identity's. */
  const studioIsTheirs = (studio: ManifestStudio, session: ManifestSession, identityId: string) =>
    studio.userId === session.userId && (studio.sbId === null || studio.sbId === identityId);

  /**
   * A session with no studio may still have worked in one: a studio's
   * worktree sits beside its repository, not under it, so the working
   * directory is matched against the session's own studios' worktrees.
   */
  const studioContaining = (session: ManifestSession, identityId: string) => {
    const dir = session.workingDir;
    if (!dir) return undefined;
    return (input.studios ?? [])
      .filter(
        (st) =>
          st.worktreePath &&
          studioIsTheirs(st, session, identityId) &&
          underRoot(dir, st.worktreePath)
      )
      .sort((a, b) => (b.worktreePath?.length ?? 0) - (a.worktreePath?.length ?? 0))[0];
  };

  type Verdict =
    | { outcome: 'valid' }
    | { outcome: 'invalid'; reason: InvalidReason; detail: InvalidDetail }
    | { outcome: 'studio-closed'; studio: ManifestStudio };

  const invalidVerdict = (reason: InvalidReason, detail: InvalidDetail = {}): Verdict => ({
    outcome: 'invalid',
    reason,
    detail,
  });

  /** Checks shared by every pointer kind. */
  const validate = (
    session: ManifestSession | undefined,
    expect: { userId: string; sbId: string | null; ownerOnly: boolean; backend: BackendRule }
  ): Verdict => {
    if (!session) return invalidVerdict('missing-session');
    if (session.userId !== expect.userId) {
      return invalidVerdict('user-mismatch', {
        expectedUser: expect.userId,
        observedUser: session.userId,
      });
    }
    const resolved = resolveIdentity(session);
    if ('unresolved' in resolved) {
      return invalidVerdict(resolved.unresolved, {
        expectedSbId: expect.sbId,
        observedSbId: null,
        observedSlug: session.sbSlug,
      });
    }
    if (expect.sbId && resolved.id !== expect.sbId) {
      return invalidVerdict('identity-mismatch', {
        expectedSbId: expect.sbId,
        observedSbId: resolved.id,
        attribution: session.sbId ? 'canonical' : 'legacy-slug',
      });
    }
    if (expect.ownerOnly && session.contactId) {
      return invalidVerdict('contact-scope', { observedContact: session.contactId });
    }
    if (expect.backend.kind === 'supported' && !normalizeRuntime(session.backend)) {
      return invalidVerdict('backend-unsupported', { observedBackend: session.backend });
    }
    if (expect.backend.kind === 'equal' && !sameBackend(expect.backend.backend, session.backend)) {
      return invalidVerdict('backend-mismatch', {
        expectedBackend: expect.backend.backend,
        observedBackend: session.backend,
      });
    }
    if (session.studioId) {
      const studio = studioById.get(session.studioId);
      if (!studio) return invalidVerdict('studio-missing', { studioId: session.studioId });
      if (!studioIsTheirs(studio, session, resolved.id)) {
        return invalidVerdict('studio-foreign', {
          studioId: session.studioId,
          studioUser: studio.userId,
          studioSbId: studio.sbId,
        });
      }
      if (studio.closed) {
        // Empty rows are refused below either way; a closed studio is a
        // recovery question only for a transcript worth recovering.
        if (empty(session)) return invalidVerdict('empty-target');
        return { outcome: 'studio-closed', studio };
      }
    }
    if (empty(session)) return invalidVerdict('empty-target');
    return { outcome: 'valid' };
  };

  /**
   * A thread pointer names an SB on a workspace-scoped thread. The thread
   * must be in that SB's workspace, the session must be the SB's own, on a
   * supported runtime, and inside the thread's project when it is pinned.
   */
  const validateThreadPointer = (p: ManifestThreadBinding): Verdict => {
    const identity = identityById.get(p.sbId);
    if (!identity) return invalidVerdict('unknown-identity', { sbId: p.sbId });
    if (!identity.workspaceId || !p.threadWorkspaceId) {
      return invalidVerdict('workspace-unknown', {
        identityWorkspace: identity.workspaceId,
        threadWorkspace: p.threadWorkspaceId,
      });
    }
    if (identity.workspaceId !== p.threadWorkspaceId) {
      return invalidVerdict('workspace-mismatch', {
        identityWorkspace: identity.workspaceId,
        threadWorkspace: p.threadWorkspaceId,
      });
    }
    const session = byId.get(p.sessionId);
    const base = validate(session, {
      userId: identity.userId,
      sbId: p.sbId,
      ownerOnly: true,
      // A transcript resumes on the runtime it was recorded on, so a supported
      // historical backend stays valid after the identity's default changes.
      backend: { kind: 'supported' },
    });
    if (base.outcome === 'invalid' || !session || p.threadProjectRepoRoot === undefined)
      return base;

    // A project-pinned thread resumes only sessions working in that project.
    if (p.threadProjectRepoRoot === null) {
      return invalidVerdict('project-unverifiable', { cause: 'unresolved-project-pin' });
    }
    const studio = session.studioId
      ? studioById.get(session.studioId)
      : studioContaining(session, p.sbId);
    const sessionRoot = studio?.repoRoot ?? session.workingDir ?? null;
    if (!sessionRoot) return invalidVerdict('project-unverifiable', { cause: 'no-session-repo' });
    if (!underRoot(sessionRoot, p.threadProjectRepoRoot)) {
      return invalidVerdict('project-mismatch', {
        expectedRepo: p.threadProjectRepoRoot,
        observedRepo: sessionRoot,
      });
    }
    return base;
  };

  /**
   * A cleaned studio is recoverable through the existing revival path only
   * when it was a thread-scoped ephemeral for this very thread (the overflow
   * service revives such a studio for the next round of its thread). Anything
   * else cannot be shown recoverable here.
   */
  const recoverableFor = (studio: ManifestStudio, threadKey: string | null | undefined) =>
    !!studio.ephemeral && !!studio.threadKey && !!threadKey && studio.threadKey === threadKey;

  const consider = (
    kind: ReferenceKind,
    ref: string,
    sessionId: string,
    verdict: Verdict,
    threadKey?: string | null
  ) => {
    if (verdict.outcome === 'valid') add(references, sessionId, kind);
    else if (verdict.outcome === 'studio-closed') {
      add(recoverableFor(verdict.studio, threadKey) ? recoverable : unrecoverable, sessionId, kind);
    } else {
      invalid.push({ kind, ref, sessionId, reason: verdict.reason, detail: verdict.detail });
    }
  };

  // Thread bindings are authoritative (spec §3 rung 4).
  const bound = new Set<string>();
  for (const b of input.bindings) {
    bound.add(`${b.threadId}|${b.sbId}`);
    consider(
      'binding',
      `${b.threadId}|${b.sbId}`,
      b.sessionId,
      validateThreadPointer(b),
      b.threadKey
    );
  }

  // Message history counts only where the thread holds no binding for the SB:
  // after a handoff the old session's last message must not keep it routable.
  for (const m of input.latestSenders) {
    if (bound.has(`${m.threadId}|${m.sbId}`)) continue;
    consider(
      'latest-sender',
      `${m.threadId}|${m.sbId}`,
      m.sessionId,
      validateThreadPointer(m),
      m.threadKey
    );
  }

  for (const identity of input.identities) {
    if (!identity.defaultSessionId) continue;
    consider(
      'home',
      identity.id,
      identity.defaultSessionId,
      validate(byId.get(identity.defaultSessionId), {
        userId: identity.userId,
        sbId: identity.id,
        ownerOnly: true,
        // A home stays on the identity's own runtime.
        backend: { kind: 'equal', backend: identity.backend },
      })
    );
  }

  for (const route of input.channelRoutes) {
    if (!route.isActive || !route.sessionId) continue;
    const identity = route.sbId ? identityById.get(route.sbId) : undefined;
    consider(
      'channel-route',
      route.id,
      route.sessionId,
      validate(byId.get(route.sessionId), {
        userId: route.userId,
        sbId: route.sbId,
        // A channel route can serve a per-sender contact session.
        ownerOnly: false,
        backend: identity ? { kind: 'equal', backend: identity.backend } : { kind: 'supported' },
      })
    );
  }

  // A session key keeps an ended row only when no live row and no other
  // ended row holds the same key in the index's scope, and the row itself
  // passes the same validation as any other pointer. Two ended holders with
  // no live one are an unresolved conflict, reported below.
  const keyOf = (s: ManifestSession) => `${keyScope(s)}|${s.sessionKey!.toLowerCase()}`;
  const liveKeys = new Set(input.sessions.filter((s) => !isEnded(s) && s.sessionKey).map(keyOf));
  const endedHolders = new Map<string, ManifestSession[]>();
  for (const s of input.sessions) {
    if (!isEnded(s) || !s.sessionKey || empty(s)) continue;
    const list = endedHolders.get(keyOf(s)) ?? [];
    list.push(s);
    endedHolders.set(keyOf(s), list);
  }
  for (const [k, holders] of endedHolders) {
    if (liveKeys.has(k) || holders.length !== 1) continue;
    const holder = holders[0];
    consider(
      'session-key',
      holder.sessionKey!.toLowerCase(),
      holder.id,
      validate(holder, {
        userId: holder.userId,
        sbId: null,
        ownerOnly: false,
        backend: { kind: 'supported' },
      })
    );
  }

  const preserved: ArchiveManifest['preserved'] = [];
  const unresolved: ArchiveManifest['unresolved'] = [];
  const archive: ArchiveManifest['archive'] = [];
  let live = 0;
  let ended = 0;
  for (const s of [...input.sessions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!isEnded(s)) {
      live += 1;
      continue;
    }
    ended += 1;
    const refs = references.get(s.id);
    const recover = recoverable.get(s.id);
    const blocked = unrecoverable.get(s.id);
    if (refs && refs.size > 0) {
      preserved.push({ sessionId: s.id, references: [...refs].sort() });
    } else if (recover && recover.size > 0) {
      preserved.push({
        sessionId: s.id,
        references: [...recover].sort(),
        requires: ['studio-recovery'],
      });
    } else if (blocked && blocked.size > 0) {
      unresolved.push({
        sessionId: s.id,
        reason: 'studio-recovery-unproven',
        references: [...blocked].sort(),
      });
    } else {
      archive.push({ sessionId: s.id, reason: empty(s) ? 'empty' : 'backfill' });
    }
  }

  // Index collisions among the rows that stay routable (or may, pending a
  // decision), and the input conflicts the key rule could not settle.
  const archivedIds = new Set(archive.map((a) => a.sessionId));
  const keyGroups = new Map<string, { scope: string; key: string; sessionIds: string[] }>();
  for (const s of input.sessions) {
    if (!s.sessionKey || archivedIds.has(s.id)) continue;
    const scope = keyScope(s);
    const key = s.sessionKey.toLowerCase();
    const g = keyGroups.get(`${scope}|${key}`) ?? { scope, key, sessionIds: [] };
    g.sessionIds.push(s.id);
    keyGroups.set(`${scope}|${key}`, g);
  }
  const indexCollisions = [...keyGroups.values()]
    .filter((g) => g.sessionIds.length > 1)
    .map((g) => ({ kind: 'index' as const, ...g, sessionIds: g.sessionIds.sort() }));
  // Holders kept by another pointer already show up as an index collision
  // above (two or more) or keep the key unopposed (one). Only a group the
  // mapping archives entirely is left with nobody holding its key.
  const unresolvedConflicts = [...endedHolders.entries()]
    .filter(
      ([k, holders]) =>
        !liveKeys.has(k) && holders.length > 1 && holders.every((h) => archivedIds.has(h.id))
    )
    .map(([, holders]) => ({
      kind: 'unresolved' as const,
      scope: keyScope(holders[0]),
      key: holders[0].sessionKey!.toLowerCase(),
      sessionIds: holders.map((h) => h.id).sort(),
    }));
  const keyCollisions = [...indexCollisions, ...unresolvedConflicts].sort((a, b) =>
    `${a.kind}|${a.scope}|${a.key}`.localeCompare(`${b.kind}|${b.scope}|${b.key}`)
  );

  // One transcript, many rows of one owner and identity: identity, not
  // routability (spec §6). A legacy row joins its identity only when its slug
  // resolves uniquely for its owner; otherwise it groups on its own.
  const backendGroups = new Map<
    string,
    { scope: string; backendSessionId: string; sessionIds: Set<string> }
  >();
  for (const s of input.sessions) {
    const resolved = resolveIdentity(s);
    const identityScope =
      'id' in resolved ? `sb:${resolved.id}` : `unresolved-slug:${s.sbSlug ?? '?'}`;
    const scope = `${s.userId}|${identityScope}`;
    for (const backendId of new Set([s.backendSessionId, s.claudeSessionId])) {
      if (!backendId) continue;
      const g = backendGroups.get(`${scope}|${backendId}`) ?? {
        scope,
        backendSessionId: backendId,
        sessionIds: new Set<string>(),
      };
      g.sessionIds.add(s.id);
      backendGroups.set(`${scope}|${backendId}`, g);
    }
  }
  const duplicateBackendIdentities = [...backendGroups.values()]
    .filter((g) => g.sessionIds.size > 1)
    .map((g) => ({
      scope: g.scope,
      backendSessionId: g.backendSessionId,
      sessionIds: [...g.sessionIds].sort(),
    }))
    .sort((a, b) =>
      `${a.scope}|${a.backendSessionId}`.localeCompare(`${b.scope}|${b.backendSessionId}`)
    );

  invalid.sort((a, b) =>
    `${a.kind}|${a.ref}|${a.sessionId}`.localeCompare(`${b.kind}|${b.ref}|${b.sessionId}`)
  );

  return {
    counts: {
      sessions: input.sessions.length,
      live,
      ended,
      preserved: preserved.length,
      preservedNeedingRecovery: preserved.filter((p) => p.requires).length,
      unresolved: unresolved.length,
      archiveBackfill: archive.filter((a) => a.reason === 'backfill').length,
      archiveEmpty: archive.filter((a) => a.reason === 'empty').length,
      invalidReferences: invalid.length,
      keyCollisionGroups: keyCollisions.length,
      keyCollisionRows: keyCollisions.reduce((n, g) => n + g.sessionIds.length, 0),
      duplicateBackendIdentities: duplicateBackendIdentities.length,
    },
    preserved,
    unresolved,
    archive,
    invalidReferences: invalid,
    keyCollisions,
    duplicateBackendIdentities,
  };
}
