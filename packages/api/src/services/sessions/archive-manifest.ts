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
 * route, or its own session key when no live row holds the same key. A
 * pointer that fails validation is reported and never preserves anything,
 * because a stale pointer is how the 2026-08-05 drift started.
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
  /** True when the activity log records a turn for this session. */
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

/** Threads are workspace-scoped; a binding is valid only inside its SB's workspace. */
export interface ManifestThreadBinding {
  threadId: string;
  threadWorkspaceId: string | null;
  sbId: string;
  sessionId: string;
}

export interface ManifestLatestSender {
  threadId: string;
  threadWorkspaceId: string | null;
  sbId: string;
  sessionId: string;
}

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
  | 'workspace-mismatch'
  | 'user-mismatch'
  | 'identity-mismatch'
  | 'backend-mismatch'
  | 'contact-scope'
  | 'empty-target';

export interface ManifestInput {
  sessions: ManifestSession[];
  identities: ManifestIdentity[];
  bindings: ManifestThreadBinding[];
  latestSenders: ManifestLatestSender[];
  channelRoutes: ManifestChannelRoute[];
}

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
  }>;
  /** Rows that would share a session key once the cutover's unique index exists. */
  keyCollisions: Array<{ scope: string; key: string; sessionIds: string[] }>;
  /** One backend conversation carried by more than one row. */
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

/** Never held a conversation: no turn in the activity log, no messages, no transcript. */
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

/** The canonical identity a row belongs to; slug only for rows that predate sb_id. */
function sbScope(s: { sbId: string | null; sbSlug?: string | null }): string {
  return s.sbId ? `sb:${s.sbId}` : `slug:${s.sbSlug ?? '?'}`;
}

/**
 * The scope of the session-key unique index, `idx_sessions_alias_unique`:
 * user, agent slug, studio. Keys compare lowercased, the way #717's lookup
 * reads them, so two spellings of one key count as one.
 */
function keyScope(s: ManifestSession): string {
  return `${s.userId}|${s.sbSlug ?? sbScope(s)}|${s.studioId ?? '-'}`;
}

export function classifySessions(input: ManifestInput): ArchiveManifest {
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  const identityById = new Map(input.identities.map((i) => [i.id, i]));
  const references = new Map<string, Set<ReferenceKind>>();
  const invalid: ArchiveManifest['invalidReferences'] = [];

  const keep = (sessionId: string, kind: ReferenceKind) => {
    const set = references.get(sessionId) ?? new Set<ReferenceKind>();
    set.add(kind);
    references.set(sessionId, set);
  };

  /** Shared checks; returns the reason a pointer is invalid, or null. */
  const validate = (
    session: ManifestSession | undefined,
    expect: { userId: string; sbId: string | null; ownerOnly: boolean; backend?: string | null }
  ): InvalidReason | null => {
    if (!session) return 'missing-session';
    if (session.userId !== expect.userId) return 'user-mismatch';
    if (expect.sbId && session.sbId && session.sbId !== expect.sbId) return 'identity-mismatch';
    if (expect.sbId && !session.sbId) {
      const identity = identityById.get(expect.sbId);
      if (!identity || identity.slug !== session.sbSlug) return 'identity-mismatch';
    }
    if (expect.ownerOnly && session.contactId) return 'contact-scope';
    if (expect.backend !== undefined && !sameBackend(expect.backend, session.backend)) {
      return 'backend-mismatch';
    }
    if (isEmpty(session)) return 'empty-target';
    return null;
  };

  const consider = (
    kind: ReferenceKind,
    ref: string,
    sessionId: string,
    reason: InvalidReason | null
  ) => {
    if (reason) invalid.push({ kind, ref, sessionId, reason });
    else keep(sessionId, kind);
  };

  // Thread bindings are authoritative (spec §3 rung 4).
  const bound = new Set<string>();
  /**
   * A thread pointer names an SB on a workspace-scoped thread. The session
   * must belong to that SB's owner, and the thread to that SB's workspace.
   */
  const validateThreadPointer = (p: {
    threadWorkspaceId: string | null;
    sbId: string;
    sessionId: string;
  }): InvalidReason | null => {
    const identity = identityById.get(p.sbId);
    if (!identity) return 'unknown-identity';
    if (
      identity.workspaceId &&
      p.threadWorkspaceId &&
      identity.workspaceId !== p.threadWorkspaceId
    ) {
      return 'workspace-mismatch';
    }
    return validate(byId.get(p.sessionId), {
      userId: identity.userId,
      sbId: p.sbId,
      ownerOnly: true,
    });
  };

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
    const session = byId.get(identity.defaultSessionId);
    consider(
      'home',
      identity.id,
      identity.defaultSessionId,
      validate(session, {
        userId: identity.userId,
        sbId: identity.id,
        ownerOnly: true,
        backend: identity.backend,
      })
    );
  }

  for (const route of input.channelRoutes) {
    if (!route.isActive || !route.sessionId) continue;
    const session = byId.get(route.sessionId);
    const identity = route.sbId ? identityById.get(route.sbId) : undefined;
    consider(
      'channel-route',
      route.id,
      route.sessionId,
      validate(session, {
        userId: route.userId,
        sbId: route.sbId,
        // A channel route can serve a per-sender contact session.
        ownerOnly: false,
        ...(identity ? { backend: identity.backend } : {}),
      })
    );
  }

  // A session key keeps an ended row only when no live row and no other
  // preserved row already answers to the same key in the same scope.
  const liveKeys = new Set(
    input.sessions
      .filter((s) => !isEnded(s) && s.sessionKey)
      .map((s) => `${keyScope(s)}|${s.sessionKey!.toLowerCase()}`)
  );
  const endedKeyed = input.sessions
    .filter((s) => isEnded(s) && s.sessionKey && !isEmpty(s))
    .sort((a, b) => a.id.localeCompare(b.id));
  const endedKeyCounts = new Map<string, number>();
  for (const s of endedKeyed) {
    const k = `${keyScope(s)}|${s.sessionKey!.toLowerCase()}`;
    endedKeyCounts.set(k, (endedKeyCounts.get(k) ?? 0) + 1);
  }
  for (const s of endedKeyed) {
    const k = `${keyScope(s)}|${s.sessionKey!.toLowerCase()}`;
    if (!liveKeys.has(k) && endedKeyCounts.get(k) === 1) keep(s.id, 'session-key');
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

  // Collisions the cutover's `WHERE archived_at IS NULL` key index would hit.
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
  const keyCollisions = [...keyGroups.values()]
    .filter((g) => g.sessionIds.length > 1)
    .map((g) => ({ ...g, sessionIds: g.sessionIds.sort() }))
    .sort((a, b) => `${a.scope}|${a.key}`.localeCompare(`${b.scope}|${b.key}`));

  // One transcript, many rows: identity, not routability (spec §6).
  const backendGroups = new Map<
    string,
    { scope: string; backendSessionId: string; sessionIds: Set<string> }
  >();
  for (const s of input.sessions) {
    for (const backendId of new Set([s.backendSessionId, s.claudeSessionId])) {
      if (!backendId) continue;
      const scope = sbScope(s);
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
