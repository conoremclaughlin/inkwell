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
 * started. Anything uncertain stays out of `empty`, the archive reason that
 * refuses even an explicit address (Lumen, review of PR #720).
 */

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
  messageCount: number | null;
  /** Working directory the session last reported, when it has no studio. */
  workingDir?: string | null;
  /**
   * Positive evidence that the session ran or spoke: any activity row for it
   * (a turn, a tool call), a CLI turn boundary, or an inbox message it
   * authored. Without it a row can be called empty; with it, never.
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
}

/** Threads are workspace-scoped; a pointer is valid only inside its SB's workspace. */
export interface ManifestThreadBinding {
  threadId: string;
  threadWorkspaceId: string | null;
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
  | 'backend-mismatch'
  | 'contact-scope'
  | 'studio-missing'
  | 'studio-closed'
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
}

/** Expected versus observed, kept in the private manifest so causes can be told apart. */
export type InvalidDetail = Record<string, string | null>;

export interface ArchiveManifest {
  counts: {
    sessions: number;
    live: number;
    ended: number;
    preserved: number;
    archiveBackfill: number;
    archiveEmpty: number;
    invalidReferences: number;
    keyCollisionGroups: number;
    keyCollisionRows: number;
    duplicateBackendIdentities: number;
  };
  /** Ended sessions that stay routable, with every valid reference that keeps them. */
  preserved: Array<{ sessionId: string; references: ReferenceKind[] }>;
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

/** Never held a conversation: no evidence it ran or spoke, no messages, no transcript. */
export function isEmpty(s: ManifestSession): boolean {
  return !s.hasExecuted && (s.messageCount ?? 0) === 0 && !s.backendSessionId && !s.claudeSessionId;
}

/**
 * Identity and session rows spell some backends differently. Only these
 * pairs are known to mean the same runtime; anything else must match exactly.
 */
const BACKEND_ALIASES: ReadonlyArray<readonly string[]> = [
  ['claude', 'claude-code'],
  ['codex', 'codex-cli'],
];

export function sameBackend(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return BACKEND_ALIASES.some((group) => group.includes(a) && group.includes(b));
}

/**
 * The scope of the session-key unique index, `idx_sessions_alias_unique`:
 * user, agent slug, studio. Keys compare lowercased, the way #717's lookup
 * reads them, so two spellings of one key count as one.
 */
function keyScope(s: ManifestSession): string {
  return `${s.userId}|${s.sbSlug ?? s.sbId ?? '?'}|${s.studioId ?? '-'}`;
}

function underRoot(path: string, root: string): boolean {
  const trimmed = root.replace(/\/+$/, '');
  return path === trimmed || path.startsWith(`${trimmed}/`);
}

export function classifySessions(input: ManifestInput): ArchiveManifest {
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  const identityById = new Map(input.identities.map((i) => [i.id, i]));
  const studioById = new Map((input.studios ?? []).map((s) => [s.id, s]));
  const references = new Map<string, Set<ReferenceKind>>();
  const invalid: ArchiveManifest['invalidReferences'] = [];

  /**
   * A session with no studio may still have worked in one: a studio's
   * worktree sits beside its repository, not under it, so the working
   * directory is matched against worktrees before it is read as a repo path.
   */
  const studioContaining = (dir: string | null): ManifestStudio | undefined => {
    if (!dir) return undefined;
    return (input.studios ?? [])
      .filter((st) => st.worktreePath && underRoot(dir, st.worktreePath))
      .sort((a, b) => (b.worktreePath?.length ?? 0) - (a.worktreePath?.length ?? 0))[0];
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

  const keep = (sessionId: string, kind: ReferenceKind) => {
    const set = references.get(sessionId) ?? new Set<ReferenceKind>();
    set.add(kind);
    references.set(sessionId, set);
  };

  type Verdict = { reason: InvalidReason; detail: InvalidDetail } | null;

  /** Checks shared by every pointer kind. */
  const validate = (
    session: ManifestSession | undefined,
    expect: { userId: string; sbId: string | null; ownerOnly: boolean; backend?: string | null }
  ): Verdict => {
    if (!session) return { reason: 'missing-session', detail: {} };
    if (session.userId !== expect.userId) {
      return {
        reason: 'user-mismatch',
        detail: { expectedUser: expect.userId, observedUser: session.userId },
      };
    }
    if (expect.sbId) {
      const resolved = resolveIdentity(session);
      if ('unresolved' in resolved) {
        return {
          reason: resolved.unresolved,
          detail: { expectedSbId: expect.sbId, observedSbId: null, observedSlug: session.sbSlug },
        };
      }
      if (resolved.id !== expect.sbId) {
        return {
          reason: 'identity-mismatch',
          detail: {
            expectedSbId: expect.sbId,
            observedSbId: resolved.id,
            attribution: session.sbId ? 'canonical' : 'legacy-slug',
          },
        };
      }
    }
    if (expect.ownerOnly && session.contactId) {
      return { reason: 'contact-scope', detail: { observedContact: session.contactId } };
    }
    if (expect.backend !== undefined && !sameBackend(expect.backend, session.backend)) {
      return {
        reason: 'backend-mismatch',
        detail: { expectedBackend: expect.backend, observedBackend: session.backend },
      };
    }
    if (session.studioId) {
      const studio = studioById.get(session.studioId);
      if (!studio || studio.userId !== session.userId) {
        return {
          reason: 'studio-missing',
          detail: { studioId: session.studioId, observed: studio ? 'other-user' : 'missing' },
        };
      }
      // Reported apart from a missing studio: a closed ephemeral studio can be
      // revived for the next round, so the cutover decides these explicitly.
      if (studio.closed) {
        return { reason: 'studio-closed', detail: { studioId: session.studioId } };
      }
    }
    if (isEmpty(session)) return { reason: 'empty-target', detail: {} };
    return null;
  };

  /**
   * A thread pointer names an SB on a workspace-scoped thread. The thread
   * must be in that SB's workspace, the session must be the SB's own, on its
   * backend, and inside the thread's project when the thread is pinned.
   */
  const validateThreadPointer = (p: ManifestThreadBinding): Verdict => {
    const identity = identityById.get(p.sbId);
    if (!identity) return { reason: 'unknown-identity', detail: { sbId: p.sbId } };
    if (!identity.workspaceId || !p.threadWorkspaceId) {
      return {
        reason: 'workspace-unknown',
        detail: { identityWorkspace: identity.workspaceId, threadWorkspace: p.threadWorkspaceId },
      };
    }
    if (identity.workspaceId !== p.threadWorkspaceId) {
      return {
        reason: 'workspace-mismatch',
        detail: { identityWorkspace: identity.workspaceId, threadWorkspace: p.threadWorkspaceId },
      };
    }
    const session = byId.get(p.sessionId);
    const base = validate(session, {
      userId: identity.userId,
      sbId: p.sbId,
      ownerOnly: true,
      backend: identity.backend,
    });
    if (base || !session || p.threadProjectRepoRoot === undefined) return base;

    // A project-pinned thread resumes only sessions working in that project.
    if (p.threadProjectRepoRoot === null) {
      return { reason: 'project-unverifiable', detail: { cause: 'unresolved-project-pin' } };
    }
    const studio = session.studioId
      ? studioById.get(session.studioId)
      : studioContaining(session.workingDir ?? null);
    const sessionRoot = studio?.repoRoot ?? session.workingDir ?? null;
    if (!sessionRoot) {
      return { reason: 'project-unverifiable', detail: { cause: 'no-session-repo' } };
    }
    if (!underRoot(sessionRoot, p.threadProjectRepoRoot)) {
      return {
        reason: 'project-mismatch',
        detail: { expectedRepo: p.threadProjectRepoRoot, observedRepo: sessionRoot },
      };
    }
    return null;
  };

  const consider = (kind: ReferenceKind, ref: string, sessionId: string, verdict: Verdict) => {
    if (verdict) invalid.push({ kind, ref, sessionId, ...verdict });
    else keep(sessionId, kind);
  };

  // Thread bindings are authoritative (spec §3 rung 4).
  const bound = new Set<string>();
  for (const b of input.bindings) {
    bound.add(`${b.threadId}|${b.sbId}`);
    consider('binding', `${b.threadId}|${b.sbId}`, b.sessionId, validateThreadPointer(b));
  }

  // Message history counts only where the thread holds no binding for the SB:
  // after a handoff the old session's last message must not keep it routable.
  for (const m of input.latestSenders) {
    if (bound.has(`${m.threadId}|${m.sbId}`)) continue;
    consider('latest-sender', `${m.threadId}|${m.sbId}`, m.sessionId, validateThreadPointer(m));
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
        backend: identity.backend,
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
        ...(identity ? { backend: identity.backend } : {}),
      })
    );
  }

  // A session key keeps an ended row only when no live row and no other
  // ended row holds the same key in the index's scope. Two ended holders
  // with no live one are an unresolved conflict, reported below.
  const keyOf = (s: ManifestSession) => `${keyScope(s)}|${s.sessionKey!.toLowerCase()}`;
  const liveKeys = new Set(input.sessions.filter((s) => !isEnded(s) && s.sessionKey).map(keyOf));
  const endedHolders = new Map<string, ManifestSession[]>();
  for (const s of input.sessions) {
    if (!isEnded(s) || !s.sessionKey || isEmpty(s)) continue;
    const list = endedHolders.get(keyOf(s)) ?? [];
    list.push(s);
    endedHolders.set(keyOf(s), list);
  }
  for (const [k, holders] of endedHolders) {
    if (!liveKeys.has(k) && holders.length === 1) keep(holders[0].id, 'session-key');
  }

  const preserved: ArchiveManifest['preserved'] = [];
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
    if (refs && refs.size > 0) {
      preserved.push({ sessionId: s.id, references: [...refs].sort() });
    } else {
      archive.push({ sessionId: s.id, reason: isEmpty(s) ? 'empty' : 'backfill' });
    }
  }

  // Index collisions among the rows that stay routable, and the input
  // conflicts the key rule could not settle on its own.
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
  // Holders kept routable by another pointer already show up as an index
  // collision above (two or more) or keep the key unopposed (one). Only a
  // group the mapping archives entirely is left with nobody holding its key.
  const preservedIds = new Set(preserved.map((p) => p.sessionId));
  const unresolvedConflicts = [...endedHolders.entries()]
    .filter(
      ([k, holders]) =>
        !liveKeys.has(k) && holders.length > 1 && holders.every((h) => !preservedIds.has(h.id))
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
      archiveBackfill: archive.filter((a) => a.reason === 'backfill').length,
      archiveEmpty: archive.filter((a) => a.reason === 'empty').length,
      invalidReferences: invalid.length,
      keyCollisionGroups: keyCollisions.length,
      keyCollisionRows: keyCollisions.reduce((n, g) => n + g.sessionIds.length, 0),
      duplicateBackendIdentities: duplicateBackendIdentities.length,
    },
    preserved,
    archive,
    invalidReferences: invalid,
    keyCollisions,
    duplicateBackendIdentities,
  };
}
