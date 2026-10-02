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
      },
      {
        kind: 'binding',
        ref: 't-elsewhere|sb-wren',
        sessionId: 'other-workspace',
        reason: 'workspace-mismatch',
      },
      { kind: 'binding', ref: 't-empty|sb-wren', sessionId: 'empty', reason: 'empty-target' },
      {
        kind: 'binding',
        ref: 't-foreign|sb-wren',
        sessionId: 'foreign-bound',
        reason: 'user-mismatch',
      },
      { kind: 'binding', ref: 't-missing|sb-wren', sessionId: 'gone', reason: 'missing-session' },
      {
        kind: 'binding',
        ref: 't-stranger|sb-unknown',
        sessionId: 'unreferenced',
        reason: 'unknown-identity',
      },
      {
        kind: 'home',
        ref: 'sb-lumen',
        sessionId: 'lumen-home-wrong-backend',
        reason: 'backend-mismatch',
      },
    ]);
  });

  it('finds key collisions among the rows that stay routable, case-insensitively', () => {
    const manifest = classifySessions(fixture());

    // twin-a and twin-b are both preserved by bindings and share a key; the
    // shadowed row is archived, so it does not collide with the live holder.
    expect(manifest.keyCollisions).toEqual([
      { scope: 'user-1|wren|-', key: 'wren:inkwell:twin', sessionIds: ['twin-a', 'twin-b'] },
    ]);
  });

  it('finds one backend conversation carried by two rows, across both link columns', () => {
    const manifest = classifySessions(fixture());

    expect(manifest.duplicateBackendIdentities).toEqual([
      { scope: 'sb:sb-wren', backendSessionId: 'backend-shared', sessionIds: ['dup-a', 'dup-b'] },
    ]);
  });

  it('counts each class', () => {
    expect(classifySessions(fixture()).counts).toEqual({
      sessions: 20,
      live: 2,
      ended: 18,
      preserved: 7,
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
    const blank = { hasExecuted: false, messageCount: 0, backendSessionId: null };
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
