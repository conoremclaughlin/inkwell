import { describe, it, expect } from 'vitest';
import {
  classifySessions,
  isEmpty,
  isEnded,
  sameBackend,
  type ManifestInput,
  type ManifestSession,
} from './archive-manifest';

/**
 * Invented fixtures only: synthetic ids, no real sessions. Each row is built to
 * land in exactly one class, so the known answer below is the whole manifest.
 */
const USER = 'user-1';
const OTHER_USER = 'user-2';
const WREN = 'sb-wren';
const MYRA = 'sb-myra';
const LUMEN = 'sb-lumen';
const ENDED = '2026-09-01T00:00:00Z';

function session(id: string, fields: Partial<ManifestSession> = {}): ManifestSession {
  return {
    id,
    userId: USER,
    sbId: WREN,
    sbSlug: 'wren',
    studioId: null,
    contactId: null,
    backend: 'claude-code',
    backendSessionId: `backend-${id}`,
    claudeSessionId: null,
    sessionKey: null,
    endedAt: ENDED,
    lifecycle: 'idle',
    status: 'active',
    messageCount: 3,
    hasExecuted: true,
    ...fields,
  };
}

function fixture(): ManifestInput {
  return {
    sessions: [
      session('live', { endedAt: null }),
      session('bound'),
      session('history'),
      session('history-superseded'),
      session('myra-home', {
        sbId: MYRA,
        sbSlug: 'myra',
        backend: 'ink',
        status: 'completed',
        endedAt: null,
      }),
      session('lumen-home-wrong-backend', { sbId: LUMEN, sbSlug: 'lumen', backend: 'claude-code' }),
      session('routed'),
      session('route-inactive'),
      session('contact-bound', { contactId: 'contact-1' }),
      session('foreign-bound', { userId: OTHER_USER }),
      session('empty', {
        hasExecuted: false,
        messageCount: 0,
        backendSessionId: null,
        lifecycle: 'completed',
        // Synthetic: no historical row carries trusted loser provenance today.
        loserProvenance: true,
      }),
      session('keyed-solo', { sessionKey: 'wren:inkwell:solo' }),
      session('keyed-shadowed', { sessionKey: 'WREN:inkwell:main' }),
      session('live-keyed', { endedAt: null, sessionKey: 'wren:inkwell:main' }),
      session('twin-a', { sessionKey: 'wren:inkwell:twin' }),
      session('twin-b', { sessionKey: 'wren:inkwell:twin' }),
      session('dup-a', { backendSessionId: 'backend-shared' }),
      session('dup-b', { backendSessionId: null, claudeSessionId: 'backend-shared' }),
      session('unreferenced'),
      session('other-workspace'),
    ],
    identities: [
      {
        id: WREN,
        userId: USER,
        workspaceId: 'ws-1',
        slug: 'wren',
        backend: 'claude-code',
        defaultSessionId: null,
      },
      {
        id: MYRA,
        userId: USER,
        workspaceId: 'ws-1',
        slug: 'myra',
        backend: 'ink',
        defaultSessionId: 'myra-home',
      },
      {
        id: LUMEN,
        userId: USER,
        workspaceId: 'ws-1',
        slug: 'lumen',
        backend: 'codex',
        defaultSessionId: 'lumen-home-wrong-backend',
      },
    ],
    bindings: [
      { threadId: 't-bound', threadWorkspaceId: 'ws-1', sbId: WREN, sessionId: 'bound' },
      { threadId: 't-handoff', threadWorkspaceId: 'ws-1', sbId: WREN, sessionId: 'live' },
      { threadId: 't-contact', threadWorkspaceId: 'ws-1', sbId: WREN, sessionId: 'contact-bound' },
      { threadId: 't-foreign', threadWorkspaceId: 'ws-1', sbId: WREN, sessionId: 'foreign-bound' },
      { threadId: 't-empty', threadWorkspaceId: 'ws-1', sbId: WREN, sessionId: 'empty' },
      { threadId: 't-missing', threadWorkspaceId: 'ws-1', sbId: WREN, sessionId: 'gone' },
      { threadId: 't-twin-a', threadWorkspaceId: 'ws-1', sbId: WREN, sessionId: 'twin-a' },
      { threadId: 't-twin-b', threadWorkspaceId: 'ws-1', sbId: WREN, sessionId: 'twin-b' },
      // A thread in another workspace cannot keep this SB's session routable.
      {
        threadId: 't-elsewhere',
        threadWorkspaceId: 'ws-2',
        sbId: WREN,
        sessionId: 'other-workspace',
      },
      {
        threadId: 't-stranger',
        threadWorkspaceId: 'ws-1',
        sbId: 'sb-unknown',
        sessionId: 'unreferenced',
      },
    ],
    latestSenders: [
      { threadId: 't-history', threadWorkspaceId: 'ws-1', sbId: WREN, sessionId: 'history' },
      // The thread binds WREN to `live`; an older session's last message there
      // must not keep it routable.
      {
        threadId: 't-handoff',
        threadWorkspaceId: 'ws-1',
        sbId: WREN,
        sessionId: 'history-superseded',
      },
    ],
    channelRoutes: [
      { id: 'route-1', userId: USER, sbId: WREN, sessionId: 'routed', isActive: true },
      { id: 'route-2', userId: USER, sbId: WREN, sessionId: 'route-inactive', isActive: false },
    ],
  };
}

describe('classifySessions (session lifecycle cutover dry run)', () => {
  it('preserves every validly referenced ended session, with the references that keep it', () => {
    const manifest = classifySessions(fixture());

    expect(manifest.preserved).toEqual([
      { sessionId: 'bound', references: ['binding'] },
      { sessionId: 'history', references: ['latest-sender'] },
      { sessionId: 'keyed-solo', references: ['session-key'] },
      { sessionId: 'myra-home', references: ['home'] },
      { sessionId: 'routed', references: ['channel-route'] },
      { sessionId: 'twin-a', references: ['binding'] },
      { sessionId: 'twin-b', references: ['binding'] },
    ]);
  });

  it('archives unreferenced history as backfill and empty rows as empty', () => {
    const manifest = classifySessions(fixture());

    expect(manifest.archive).toEqual([
      { sessionId: 'contact-bound', reason: 'backfill' },
      { sessionId: 'dup-a', reason: 'backfill' },
      { sessionId: 'dup-b', reason: 'backfill' },
      { sessionId: 'empty', reason: 'empty' },
      { sessionId: 'foreign-bound', reason: 'backfill' },
      { sessionId: 'history-superseded', reason: 'backfill' },
      { sessionId: 'keyed-shadowed', reason: 'backfill' },
      { sessionId: 'lumen-home-wrong-backend', reason: 'backfill' },
      { sessionId: 'other-workspace', reason: 'backfill' },
      { sessionId: 'route-inactive', reason: 'backfill' },
      { sessionId: 'unreferenced', reason: 'backfill' },
    ]);
  });

  it('reports every invalid pointer and never lets one preserve a row', () => {
    const manifest = classifySessions(fixture());

    expect(manifest.invalidReferences).toEqual([
      {
        kind: 'binding',
        ref: 't-contact|sb-wren',
        sessionId: 'contact-bound',
        reason: 'contact-scope',
        detail: { observedContact: 'contact-1' },
      },
      {
        kind: 'binding',
        ref: 't-elsewhere|sb-wren',
        sessionId: 'other-workspace',
        reason: 'workspace-mismatch',
        detail: { identityWorkspace: 'ws-1', threadWorkspace: 'ws-2' },
      },
      {
        kind: 'binding',
        ref: 't-empty|sb-wren',
        sessionId: 'empty',
        reason: 'empty-target',
        detail: {},
      },
      {
        kind: 'binding',
        ref: 't-foreign|sb-wren',
        sessionId: 'foreign-bound',
        reason: 'user-mismatch',
        detail: { expectedUser: USER, observedUser: OTHER_USER },
      },
      {
        kind: 'binding',
        ref: 't-missing|sb-wren',
        sessionId: 'gone',
        reason: 'missing-session',
        detail: {},
      },
      {
        kind: 'binding',
        ref: 't-stranger|sb-unknown',
        sessionId: 'unreferenced',
        reason: 'unknown-identity',
        detail: { sbId: 'sb-unknown' },
      },
      {
        kind: 'home',
        ref: 'sb-lumen',
        sessionId: 'lumen-home-wrong-backend',
        reason: 'backend-mismatch',
        detail: { expectedBackend: 'codex', observedBackend: 'claude-code' },
      },
    ]);
  });

  it('finds key collisions among the rows that stay routable, case-insensitively', () => {
    const manifest = classifySessions(fixture());

    // twin-a and twin-b are both preserved by bindings and share a key; the
    // shadowed row is archived, so it does not collide with the live holder.
    expect(manifest.keyCollisions).toEqual([
      {
        kind: 'index',
        scope: 'user-1|wren|-',
        key: 'wren:inkwell:twin',
        sessionIds: ['twin-a', 'twin-b'],
      },
    ]);
  });

  it('finds one backend conversation carried by two rows, across both link columns', () => {
    const manifest = classifySessions(fixture());

    expect(manifest.duplicateBackendIdentities).toEqual([
      {
        scope: 'user-1|sb:sb-wren',
        backendSessionId: 'backend-shared',
        sessionIds: ['dup-a', 'dup-b'],
      },
    ]);
  });

  it('counts each class', () => {
    expect(classifySessions(fixture()).counts).toEqual({
      sessions: 20,
      live: 2,
      ended: 18,
      preserved: 7,
      preservedNeedingRecovery: 0,
      unresolved: 0,
      archiveBackfill: 10,
      archiveEmpty: 1,
      invalidReferences: 7,
      keyCollisionGroups: 1,
      keyCollisionRows: 2,
      duplicateBackendIdentities: 1,
    });
  });

  it('is deterministic: the same rows in any order give the same manifest', () => {
    const input = fixture();
    const reversed: ManifestInput = {
      sessions: [...input.sessions].reverse(),
      identities: [...input.identities].reverse(),
      bindings: [...input.bindings].reverse(),
      latestSenders: [...input.latestSenders].reverse(),
      channelRoutes: [...input.channelRoutes].reverse(),
    };

    expect(classifySessions(reversed)).toEqual(classifySessions(input));
  });

  it('never archives a live row, whatever references it', () => {
    const manifest = classifySessions(fixture());
    const touched = [
      ...manifest.preserved.map((p) => p.sessionId),
      ...manifest.archive.map((a) => a.sessionId),
    ];

    expect(touched).not.toContain('live');
    expect(touched).not.toContain('live-keyed');
  });
});

describe('classifier predicates', () => {
  it('treats each terminal marker as ended, and none of them alone as live', () => {
    expect(isEnded(session('a'))).toBe(true);
    expect(isEnded(session('b', { endedAt: null, lifecycle: 'completed' }))).toBe(true);
    expect(isEnded(session('c', { endedAt: null, status: 'completed:merged' }))).toBe(true);
    expect(isEnded(session('d', { endedAt: null }))).toBe(false);
    expect(isEnded(session('e', { endedAt: null, lifecycle: 'failed' }))).toBe(false);
  });

  it('calls a row empty only when nothing shows it ever held a conversation', () => {
    const blank = {
      hasExecuted: false,
      messageCount: 0,
      backendSessionId: null,
      loserProvenance: true,
    };
    expect(isEmpty(session('a', blank))).toBe(true);
    expect(isEmpty(session('b', { ...blank, hasExecuted: true }))).toBe(false);
    expect(isEmpty(session('c', { ...blank, messageCount: 1 }))).toBe(false);
    expect(isEmpty(session('d', { ...blank, claudeSessionId: 'x' }))).toBe(false);
  });

  it('matches backend spellings only through the known alias pairs', () => {
    expect(sameBackend('claude', 'claude-code')).toBe(true);
    expect(sameBackend('codex', 'codex-cli')).toBe(true);
    expect(sameBackend('ink', 'ink')).toBe(true);
    expect(sameBackend('codex', 'claude-code')).toBe(false);
    expect(sameBackend(null, 'ink')).toBe(false);
  });
});

/**
 * Regressions from Lumen's review of PR #720: each case failed against the
 * first head (1645ce34). Synthetic rows only.
 */
describe('classifySessions: review regressions', () => {
  const wren = {
    id: WREN,
    userId: USER,
    workspaceId: 'ws-1',
    slug: 'wren',
    backend: 'claude-code',
    defaultSessionId: null,
  };
  const bind = (sessionId: string, extra: Record<string, unknown> = {}) => ({
    threadId: `t-${sessionId}`,
    threadWorkspaceId: 'ws-1',
    sbId: WREN,
    sessionId,
    ...extra,
  });
  const only = (patch: Partial<ManifestInput>): ManifestInput => ({
    sessions: [],
    identities: [wren],
    bindings: [],
    latestSenders: [],
    channelRoutes: [],
    ...patch,
  });

  it('never infers an identity from a legacy slug two identities of the owner share', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('legacy', { sbId: null })],
        identities: [wren, { ...wren, id: 'sb-wren-elsewhere', workspaceId: 'ws-2' }],
        bindings: [bind('legacy')],
      })
    );

    expect(manifest.preserved).toEqual([]);
    expect(manifest.invalidReferences.map((i) => i.reason)).toEqual(['legacy-identity-ambiguous']);
  });

  it('resolves a legacy slug that exactly one identity of the owner carries (control)', () => {
    const manifest = classifySessions(
      only({ sessions: [session('legacy', { sbId: null })], bindings: [bind('legacy')] })
    );

    expect(manifest.preserved).toEqual([{ sessionId: 'legacy', references: ['binding'] }]);
  });

  it('refuses a binding whose thread workspace is unknown', () => {
    const manifest = classifySessions(
      only({ sessions: [session('bound')], bindings: [bind('bound', { threadWorkspaceId: null })] })
    );

    expect(manifest.preserved).toEqual([]);
    expect(manifest.invalidReferences.map((i) => i.reason)).toEqual(['workspace-unknown']);
  });

  it('refuses a binding to a session on a runtime nothing supports', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('bound', { backend: 'unsupported-runtime' })],
        bindings: [bind('bound')],
      })
    );

    expect(manifest.preserved).toEqual([]);
    expect(manifest.invalidReferences.map((i) => i.reason)).toEqual(['backend-unsupported']);
  });

  it('keeps a bound transcript on its supported runtime after the identity default changes', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('bound', { backend: 'claude-code' })],
        identities: [{ ...wren, backend: 'codex' }],
        bindings: [bind('bound')],
      })
    );

    expect(manifest.preserved).toEqual([{ sessionId: 'bound', references: ['binding'] }]);
  });

  it('never admits a runtime because two rows agree on an unsupported name', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('bound', { backend: 'unsupported-runtime' })],
        identities: [{ ...wren, backend: 'unsupported-runtime' }],
        bindings: [bind('bound')],
      })
    );

    expect(manifest.preserved).toEqual([]);
  });

  it('reports ended key holders that all archive as an unresolved conflict', () => {
    const manifest = classifySessions(
      only({
        sessions: [
          session('first', { sessionKey: 'wren:inkwell:review' }),
          session('second', { sessionKey: 'WREN:inkwell:review' }),
        ],
      })
    );

    expect(manifest.archive.map((a) => a.sessionId)).toEqual(['first', 'second']);
    expect(manifest.keyCollisions).toEqual([
      {
        kind: 'unresolved',
        scope: 'user-1|wren|-',
        key: 'wren:inkwell:review',
        sessionIds: ['first', 'second'],
      },
    ]);
  });

  it('groups a legacy row with its canonical twin when the slug resolves uniquely', () => {
    const manifest = classifySessions(
      only({
        sessions: [
          session('legacy', { sbId: null, backendSessionId: 'same-transcript' }),
          session('canonical', { backendSessionId: 'same-transcript' }),
        ],
      })
    );

    expect(manifest.duplicateBackendIdentities).toEqual([
      {
        scope: 'user-1|sb:sb-wren',
        backendSessionId: 'same-transcript',
        sessionIds: ['canonical', 'legacy'],
      },
    ]);
  });

  it('never groups legacy rows of different owners', () => {
    const manifest = classifySessions(
      only({
        sessions: [
          session('owner-one', { sbId: null, backendSessionId: 'same-transcript' }),
          session('owner-two', {
            userId: OTHER_USER,
            sbId: null,
            backendSessionId: 'same-transcript',
          }),
        ],
      })
    );

    expect(manifest.duplicateBackendIdentities).toEqual([]);
  });

  it('treats a cleaned studio as a recovery question, never as an archive decision', () => {
    const manifest = classifySessions(
      only({
        sessions: [
          session('in-closed', { studioId: 'studio-closed' }),
          session('in-revivable', { studioId: 'studio-revivable' }),
          session('in-missing', { studioId: 'studio-missing' }),
          session('in-open', { studioId: 'studio-open' }),
        ],
        studios: [
          { id: 'studio-closed', userId: USER, sbId: WREN, repoRoot: '/repo', closed: true },
          {
            id: 'studio-revivable',
            userId: USER,
            sbId: WREN,
            repoRoot: '/repo',
            closed: true,
            ephemeral: true,
            threadKey: 'pr:42',
            parentStudioId: 'studio-parent',
          },
          { id: 'studio-parent', userId: USER, sbId: WREN, repoRoot: '/repo', closed: false },
          { id: 'studio-open', userId: USER, sbId: WREN, repoRoot: '/repo', closed: false },
        ],
        bindings: [
          bind('in-closed'),
          bind('in-revivable', { threadKey: 'pr:42' }),
          bind('in-missing'),
          bind('in-open'),
        ],
      })
    );

    // A cleaned ephemeral studio for this very thread can be revived, so the
    // transcript stays routable behind a recovery step; a cleaned studio that
    // cannot be shown recoverable is left for the cutover to decide.
    expect(manifest.preserved).toEqual([
      { sessionId: 'in-open', references: ['binding'] },
      { sessionId: 'in-revivable', references: ['binding'], requires: ['studio-recovery'] },
    ]);
    expect(manifest.unresolved).toEqual([
      { sessionId: 'in-closed', reason: 'studio-recovery-unproven', references: ['binding'] },
    ]);
    expect(manifest.archive.map((a) => a.sessionId)).toEqual(['in-missing']);
    expect(manifest.invalidReferences.map((i) => [i.sessionId, i.reason])).toEqual([
      ['in-missing', 'studio-missing'],
    ]);
  });

  it('refuses a studio that belongs to another identity of the same owner', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('bound', { studioId: 'studio-other-sb' })],
        identities: [wren, { ...wren, id: 'sb-other', slug: 'other' }],
        studios: [
          {
            id: 'studio-other-sb',
            userId: USER,
            sbId: 'sb-other',
            repoRoot: '/repo',
            closed: false,
          },
        ],
        bindings: [bind('bound')],
      })
    );

    expect(manifest.invalidReferences.map((i) => i.reason)).toEqual(['studio-foreign']);
  });

  it('keeps a pinned thread to sessions working inside its project', () => {
    const manifest = classifySessions(
      only({
        sessions: [
          session('in-project', { studioId: 'studio-inkwell' }),
          session('elsewhere', { studioId: 'studio-other' }),
          session('root-checkout', { workingDir: '/repos/inkwell/packages/api' }),
          // No studio row on the session, but its working directory is a
          // studio's worktree, which sits beside the repository root.
          session('in-worktree', { workingDir: '/repos/inkwell--review/packages/api' }),
          session('nowhere'),
          session('unpinned-project'),
        ],
        studios: [
          {
            id: 'studio-inkwell',
            userId: USER,
            sbId: WREN,
            repoRoot: '/repos/inkwell',
            closed: false,
          },
          {
            id: 'studio-other',
            userId: USER,
            sbId: WREN,
            repoRoot: '/repos/inktrade',
            closed: false,
          },
          {
            id: 'studio-review',
            userId: USER,
            sbId: WREN,
            repoRoot: '/repos/inkwell',
            worktreePath: '/repos/inkwell--review',
            closed: false,
          },
        ],
        bindings: [
          bind('in-project', { threadProjectRepoRoot: '/repos/inkwell' }),
          bind('elsewhere', { threadProjectRepoRoot: '/repos/inkwell' }),
          bind('root-checkout', { threadProjectRepoRoot: '/repos/inkwell' }),
          bind('in-worktree', { threadProjectRepoRoot: '/repos/inkwell' }),
          bind('nowhere', { threadProjectRepoRoot: '/repos/inkwell' }),
          bind('unpinned-project', { threadProjectRepoRoot: null }),
        ],
      })
    );

    expect(manifest.preserved.map((p) => p.sessionId)).toEqual([
      'in-project',
      'in-worktree',
      'root-checkout',
    ]);
    expect(manifest.invalidReferences.map((i) => [i.sessionId, i.reason])).toEqual([
      ['elsewhere', 'project-mismatch'],
      ['nowhere', 'project-unverifiable'],
      ['unpinned-project', 'project-unverifiable'],
    ]);
  });
});

/** Regressions from Lumen's second review of PR #720; each failed against b8fcc639. */
describe('classifySessions: review round 2', () => {
  const wren = {
    id: WREN,
    userId: USER,
    workspaceId: 'ws-1',
    slug: 'wren',
    backend: 'claude-code',
    defaultSessionId: null,
  };
  const only = (patch: Partial<ManifestInput>): ManifestInput => ({
    sessions: [],
    identities: [wren],
    bindings: [],
    latestSenders: [],
    channelRoutes: [],
    ...patch,
  });
  const pinned = (sessionId: string) => ({
    threadId: `t-${sessionId}`,
    threadWorkspaceId: 'ws-1',
    sbId: WREN,
    sessionId,
    threadProjectRepoRoot: '/repos/one',
  });

  it('a session key cannot preserve a row whose legacy identity is ambiguous', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('keyed', { sbId: null, sessionKey: 'wren:inkwell:review' })],
        identities: [wren, { ...wren, id: 'sb-wren-elsewhere', workspaceId: 'ws-2' }],
      })
    );

    expect(manifest.preserved).toEqual([]);
    expect(manifest.invalidReferences.map((i) => [i.kind, i.reason])).toEqual([
      ['session-key', 'legacy-identity-ambiguous'],
    ]);
  });

  it('a session key cannot preserve a row on an unsupported runtime', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('keyed', { backend: 'unsupported-runtime', sessionKey: 'wren:x:y' })],
      })
    );

    expect(manifest.preserved).toEqual([]);
    expect(manifest.invalidReferences.map((i) => [i.kind, i.reason])).toEqual([
      ['session-key', 'backend-unsupported'],
    ]);
  });

  it('never takes project evidence from another owner’s worktree', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('bound', { workingDir: '/worktrees/foreign/src' })],
        studios: [
          {
            id: 'studio-foreign',
            userId: OTHER_USER,
            sbId: 'sb-foreign',
            repoRoot: '/repos/one',
            worktreePath: '/worktrees/foreign',
            closed: false,
          },
        ],
        bindings: [pinned('bound')],
      })
    );

    expect(manifest.preserved).toEqual([]);
    expect(manifest.invalidReferences.map((i) => i.reason)).toEqual(['studio-foreign']);
  });

  it('never accepts a working directory that climbs out of the project', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('bound', { workingDir: '/repos/one/../two' })],
        bindings: [pinned('bound')],
      })
    );

    expect(manifest.preserved).toEqual([]);
    expect(manifest.invalidReferences.map((i) => i.reason)).toEqual(['project-mismatch']);
  });

  it('accepts a working directory inside the project after normalisation (control)', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('bound', { workingDir: '/repos/one/packages/../src' })],
        bindings: [pinned('bound')],
      })
    );

    expect(manifest.preserved).toEqual([{ sessionId: 'bound', references: ['binding'] }]);
  });

  it('never proves a row empty without trusted loser provenance, or with an unknown counter', () => {
    const blank = { hasExecuted: false, backendSessionId: null, claudeSessionId: null };
    // A zero counter and a silent log are absence of records, not proof.
    expect(isEmpty(session('a', { ...blank, messageCount: 0 }))).toBe(false);
    expect(isEmpty(session('b', { ...blank, messageCount: 0, loserProvenance: false }))).toBe(
      false
    );
    expect(isEmpty(session('c', { ...blank, messageCount: null, loserProvenance: true }))).toBe(
      false
    );
    expect(isEmpty(session('d', { ...blank, messageCount: 0, loserProvenance: true }))).toBe(true);
  });
});

/** Regressions from Lumen's third review of PR #720; each failed against fe5e1f3b. */
describe('classifySessions: review round 3', () => {
  const wren = {
    id: WREN,
    userId: USER,
    workspaceId: 'ws-1',
    slug: 'wren',
    backend: 'claude-code',
    defaultSessionId: null,
  };
  const only = (patch: Partial<ManifestInput>): ManifestInput => ({
    sessions: [],
    identities: [wren],
    bindings: [],
    latestSenders: [],
    channelRoutes: [],
    ...patch,
  });
  const pinned = (sessionId: string, threadKey = 'pr:42') => ({
    threadId: `t-${sessionId}`,
    threadWorkspaceId: 'ws-1',
    threadKey,
    sbId: WREN,
    sessionId,
    threadProjectRepoRoot: '/repos/one',
  });
  const closedEphemeral = {
    id: 'studio-eph',
    userId: USER,
    sbId: WREN,
    repoRoot: '/repos/one',
    worktreePath: '/worktrees/eph',
    closed: true,
    ephemeral: true,
    threadKey: 'pr:42',
  };

  it('a key holder whose identity row belongs to another owner is refused', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('keyed', { sessionKey: 'wren:x:y' })],
        identities: [{ ...wren, userId: OTHER_USER }],
      })
    );

    expect(manifest.preserved).toEqual([]);
    expect(manifest.invalidReferences.map((i) => i.reason)).toEqual(['identity-owner-mismatch']);
  });

  it('a key holder with no identity row is refused', () => {
    const manifest = classifySessions(
      only({ sessions: [session('keyed', { sessionKey: 'wren:x:y' })], identities: [] })
    );

    expect(manifest.preserved).toEqual([]);
    expect(manifest.invalidReferences.map((i) => i.reason)).toEqual(['unknown-identity']);
  });

  it('a closed ephemeral is unresolved without an established revival parent', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('bound', { studioId: 'studio-eph' })],
        studios: [closedEphemeral],
        bindings: [pinned('bound')],
      })
    );

    expect(manifest.unresolved.map((u) => u.sessionId)).toEqual(['bound']);
    expect(manifest.archive).toEqual([]);
  });

  it('a closed ephemeral with an open parent in the same repo is recoverable (control)', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('bound', { studioId: 'studio-eph' })],
        studios: [
          { ...closedEphemeral, parentStudioId: 'studio-parent' },
          { id: 'studio-parent', userId: USER, sbId: WREN, repoRoot: '/repos/one', closed: false },
        ],
        bindings: [pinned('bound')],
      })
    );

    expect(manifest.preserved).toEqual([
      { sessionId: 'bound', references: ['binding'], requires: ['studio-recovery'] },
    ]);
  });

  it('a parent in another repo does not establish revival', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('bound', { studioId: 'studio-eph' })],
        studios: [
          { ...closedEphemeral, parentStudioId: 'studio-parent' },
          { id: 'studio-parent', userId: USER, sbId: WREN, repoRoot: '/repos/two', closed: false },
        ],
        bindings: [pinned('bound')],
      })
    );

    expect(manifest.unresolved.map((u) => u.sessionId)).toEqual(['bound']);
  });

  it('a closed studio inferred from the working directory gets the same uncertainty', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('bound', { workingDir: '/worktrees/eph/src' })],
        studios: [{ ...closedEphemeral, ephemeral: false, threadKey: null }],
        bindings: [pinned('bound')],
      })
    );

    expect(manifest.preserved).toEqual([]);
    expect(manifest.unresolved.map((u) => u.sessionId)).toEqual(['bound']);
  });

  it('a foreign worktree nested in the project never falls back to the plain directory', () => {
    const manifest = classifySessions(
      only({
        sessions: [session('bound', { workingDir: '/repos/one/foreign/src' })],
        studios: [
          {
            id: 'studio-foreign',
            userId: OTHER_USER,
            sbId: 'sb-foreign',
            repoRoot: '/repos/one',
            worktreePath: '/repos/one/foreign',
            closed: false,
          },
        ],
        bindings: [pinned('bound')],
      })
    );

    expect(manifest.preserved).toEqual([]);
    expect(manifest.invalidReferences.map((i) => i.reason)).toEqual(['studio-foreign']);
  });
});
