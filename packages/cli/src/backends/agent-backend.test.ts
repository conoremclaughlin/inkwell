/**
 * `ink -a lumen` started Lumen on claude. The agent flag picked the identity
 * and nothing picked the runtime, so every launch needed `-b` alongside it.
 *
 * Round 1 of #665 shipped a lookup that was right about the happy path and
 * wrong about four edges, all found by Lumen. Each has a test here, named for
 * the thing it refuses to do:
 *
 *   - a slug that names two identities must not resolve to an arbitrary one
 *   - a cache from one server must not answer for another
 *   - a cache whose values are not strings must be a miss, not a crash
 *   - a slug that is also an Object.prototype member must not hand back a
 *     function
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  normalizeBackendAlias,
  isRunnableBackend,
  isCacheFresh,
  lookupAgentBackend,
  readAgentBackendCache,
  writeAgentBackendCache,
  RUNNABLE_BACKENDS,
  currentScope,
  currentPrincipal,
} from './agent-backend.js';
import { BACKEND_NAMES } from './index.js';

const SCOPE = { serverUrl: 'https://server-a.example.test', principal: 'principal-one' };
const OTHER_SERVER = { serverUrl: 'https://server-b.example.test', principal: 'principal-one' };
const OTHER_ACCOUNT = { serverUrl: 'https://server-a.example.test', principal: 'principal-two' };

/** A fetch result in the shape the server path returns. */
const fetched = (backends: Record<string, string>, ambiguous: string[] = []) =>
  vi.fn().mockResolvedValue({
    backends,
    ambiguous,
    sawAnyBackend: Object.keys(backends).length > 0 || ambiguous.length > 0,
  });

/** What an older server looks like: identities, none of them with a backend. */
const oldServer = () =>
  vi.fn().mockResolvedValue({ backends: {}, ambiguous: [], sawAnyBackend: false });

const cacheOf = (
  backends: Record<string, string>,
  opts: { age?: string; scope?: object } = {}
) => ({
  fetchedAt: opts.age ?? new Date().toISOString(),
  scope: 'scope' in opts ? opts.scope : SCOPE,
  backends,
});

describe('RUNNABLE_BACKENDS', () => {
  it('agrees with the adapter registry plus the ink runtime', () => {
    // agent-backend.ts cannot import ./index.js — that would close an import
    // cycle through the adapters — so it restates the set. This test is what
    // stops the restatement drifting when an adapter is added or removed.
    expect([...RUNNABLE_BACKENDS].sort()).toEqual([...BACKEND_NAMES, 'ink'].sort());
  });
});

describe('currentScope', () => {
  it('agrees with getInkServerUrl, whose default it restates', async () => {
    // agent-backend.ts reads INK_SERVER_URL itself instead of importing
    // ink-mcp just for one line — that import breaks any test that mocks the
    // module to control callInkTool. This keeps the two definitions honest.
    const { getInkServerUrl } = await import('../lib/ink-mcp.js');
    const original = process.env.INK_SERVER_URL;
    try {
      for (const value of [undefined, 'https://scope.example.test']) {
        if (value === undefined) delete process.env.INK_SERVER_URL;
        else process.env.INK_SERVER_URL = value;
        expect(currentScope().serverUrl).toBe(getInkServerUrl());
      }
    } finally {
      if (original === undefined) delete process.env.INK_SERVER_URL;
      else process.env.INK_SERVER_URL = original;
    }
  });
});

describe('normalizeBackendAlias', () => {
  it('collapses the spellings the identity column actually holds', () => {
    // Real values read from agent_identities on 2026-09-22: wren 'claude-code',
    // benson 'claude' — the same runtime under two names, because the column
    // has no constraint and different writers used different vocabularies.
    expect(normalizeBackendAlias('claude-code')).toBe('claude');
    expect(normalizeBackendAlias('claude')).toBe('claude');
    expect(normalizeBackendAlias('codex-cli')).toBe('codex');
    expect(normalizeBackendAlias('gemini-cli')).toBe('gemini');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeBackendAlias('  Claude-Code ')).toBe('claude');
  });

  it('passes an unknown value through rather than guessing', () => {
    // aster's record says 'antigravity'. Mapping it to something runnable
    // would start Aster on a backend nobody chose and look like it worked.
    expect(normalizeBackendAlias('antigravity')).toBe('antigravity');
    expect(isRunnableBackend('antigravity')).toBe(false);
  });

  it('treats empty and missing as no answer', () => {
    for (const empty of ['', '   ', null, undefined]) {
      expect(normalizeBackendAlias(empty)).toBeUndefined();
    }
  });
});

describe('isCacheFresh', () => {
  const now = Date.parse('2026-09-22T12:00:00Z');
  it('accepts an entry inside the day', () => {
    expect(isCacheFresh(cacheOf({}, { age: '2026-09-22T00:00:00Z' }), now)).toBe(true);
  });
  it('rejects one older than the day', () => {
    expect(isCacheFresh(cacheOf({}, { age: '2026-09-20T00:00:00Z' }), now)).toBe(false);
  });
  it('rejects a missing, malformed or future stamp', () => {
    expect(isCacheFresh(null, now)).toBe(false);
    expect(isCacheFresh(cacheOf({}, { age: 'not a date' }), now)).toBe(false);
    expect(isCacheFresh(cacheOf({}, { age: '2030-01-01T00:00:00Z' }), now)).toBe(false);
  });
});

describe('cache file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ink-agent-backend-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips, scope included', () => {
    const path = join(dir, 'agent-backends.json');
    writeAgentBackendCache({ backends: { lumen: 'codex' }, ambiguous: [] }, SCOPE, path);
    const back = readAgentBackendCache(path);
    expect(back?.backends).toEqual({ lumen: 'codex' });
    expect(back?.scope).toEqual(SCOPE);
  });

  it('treats a syntactically corrupt file as a miss instead of throwing', () => {
    const path = join(dir, 'agent-backends.json');
    writeFileSync(path, '{ not json', 'utf-8');
    expect(readAgentBackendCache(path)).toBeNull();
  });

  it('treats a SEMANTICALLY corrupt file as a miss too', () => {
    // Valid JSON, wrong shape. A number here reaches normalizeBackendAlias and
    // throws on .toLowerCase(), on the launch path, for every command.
    const path = join(dir, 'agent-backends.json');
    writeFileSync(path, JSON.stringify(cacheOf({ lumen: 42 as unknown as string })), 'utf-8');
    expect(readAgentBackendCache(path)).toBeNull();
  });

  it('preserves refusals through a real write/read round-trip', () => {
    // Every lookup test injects its own writeCache, so the REAL writer is
    // unexercised there — dropping `ambiguous` from it turned nothing red.
    const path = join(dir, 'agent-backends.json');
    writeAgentBackendCache({ backends: { lumen: 'codex' }, ambiguous: ['echo'] }, SCOPE, path);
    expect(readAgentBackendCache(path)?.ambiguous).toEqual(['echo']);
  });

  it('creates the directory when ~/.ink does not exist yet', () => {
    const path = join(dir, 'nested', 'agent-backends.json');
    writeAgentBackendCache({ backends: { wren: 'claude-code' }, ambiguous: [] }, SCOPE, path);
    expect(existsSync(path)).toBe(true);
  });
});

/** A synthetic unsigned JWT — only the `sub` claim is read. */
const token = (sub: string) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
      'base64url'
    ),
    'synthetic-signature',
  ].join('.');

describe('principal, derived from the real credential', () => {
  // Every other test injects `scope`, which would stay green if the token were
  // never read at all. These drive it the way production does, and they need
  // BOTH poles: "a different account misses" is also satisfied by a cache that
  // is never usable, so the same-account HIT is what proves derivation works.
  const original = process.env.INK_ACCESS_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.INK_ACCESS_TOKEN;
    else process.env.INK_ACCESS_TOKEN = original;
  });

  it('reuses its own cache offline, and refuses another account\u2019s', async () => {
    let stored: unknown = null;
    const readCache = () => stored as never;
    const writeCache = (entry: unknown, scope?: object) => {
      stored = { fetchedAt: new Date().toISOString(), scope, ...(entry as object) };
    };

    process.env.INK_ACCESS_TOKEN = token('synthetic-user-a');
    const filled = await lookupAgentBackend('fixture', {
      readCache,
      writeCache,
      fetch: fetched({ fixture: 'codex' }),
    });
    expect(filled.backend).toBe('codex');
    expect(
      (stored as { scope?: { principal?: string } }).scope?.principal,
      'no principal was recorded, so the token is not being read'
    ).toBeTruthy();

    // POSITIVE pole: same account, server unreachable — the cache is ours.
    const mine = await lookupAgentBackend('fixture', {
      readCache,
      writeCache,
      fetch: vi.fn().mockRejectedValue(new Error('offline')),
    });
    expect(mine.backend, 'an account could not read back its own cache').toBe('codex');

    // NEGATIVE pole: different account on the same server.
    process.env.INK_ACCESS_TOKEN = token('synthetic-user-b');
    const theirs = await lookupAgentBackend('fixture', {
      readCache,
      writeCache,
      fetch: vi.fn().mockRejectedValue(new Error('offline')),
    });
    expect(theirs.backend, "another account read this account's cache").toBeUndefined();
  });

  it('ignores a provably expired env token, as the real selector does', () => {
    // Round 2 read INK_ACCESS_TOKEN unconditionally. getValidAccessToken skips
    // an expired one and falls back to stored auth, so restating the rule
    // without the expiry check names a different account than the request uses.
    const expired = (sub: string) =>
      [
        Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
        Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) - 3600 })).toString(
          'base64url'
        ),
        'synthetic-signature',
      ].join('.');

    process.env.INK_ACCESS_TOKEN = token('synthetic-user-a');
    const live = currentPrincipal();
    process.env.INK_ACCESS_TOKEN = expired('synthetic-user-a');
    const dead = currentPrincipal();

    // With no stored auth on this machine the expired token yields nothing;
    // with stored auth it yields THAT account. Either way it must not report
    // the expired token's account.
    expect(dead, 'an expired env token still named its account').not.toBe(live);
  });

  it('binds the cache write to the principal in force after the request', async () => {
    // The pre-request principal and the post-request one are normally equal.
    // When they are not — the credential changed while the call was in flight —
    // the response belongs to whoever the request authenticated as, and filing
    // it under the earlier guess puts one account's answers under another.
    let stored: { scope?: { principal?: string }; backends: Record<string, string> } | null = null;
    const writeCache = (entry: unknown, scope?: object) => {
      stored = { scope, ...(entry as object) } as typeof stored;
    };

    process.env.INK_ACCESS_TOKEN = token('synthetic-user-a');
    const before = currentPrincipal();

    await lookupAgentBackend('fixture', {
      readCache: () => null,
      writeCache,
      // The credential changes during the call, as a re-login elsewhere would.
      fetch: async () => {
        process.env.INK_ACCESS_TOKEN = token('synthetic-user-b');
        return { backends: { fixture: 'codex' }, ambiguous: [], sawAnyBackend: true };
      },
    });

    const after = currentPrincipal();
    expect(after).not.toBe(before);
    expect(stored!.scope?.principal, 'the write used the pre-request principal').toBe(after);
  });

  it('records different principals for different accounts', () => {
    process.env.INK_ACCESS_TOKEN = token('synthetic-user-a');
    const a = currentPrincipal();
    process.env.INK_ACCESS_TOKEN = token('synthetic-user-b');
    const b = currentPrincipal();
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    // Hashed: the file has no business holding a user id to answer "same or not".
    expect(a).not.toContain('synthetic-user-a');
  });
});

describe('lookupAgentBackend', () => {
  const fresh = () => cacheOf({ lumen: 'codex', wren: 'claude-code', aster: 'antigravity' });

  it('answers from a fresh in-scope cache without calling the server', async () => {
    const fetch = vi.fn();
    const r = await lookupAgentBackend('lumen', { readCache: () => fresh(), fetch, scope: SCOPE });
    expect(r).toEqual({ backend: 'codex', source: 'cache' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalises on read, so a fixed alias table reaches old cache files', async () => {
    // The cache stores the RAW value on purpose. If it stored 'claude' we
    // could never correct a mapping without everyone deleting their cache.
    const r = await lookupAgentBackend('wren', {
      readCache: () => fresh(),
      fetch: vi.fn(),
      scope: SCOPE,
    });
    expect(r.backend).toBe('claude');
  });

  it('fetches and caches when the cache is stale', async () => {
    const writeCache = vi.fn();
    const r = await lookupAgentBackend('lumen', {
      readCache: () => cacheOf({ lumen: 'claude' }, { age: '2020-01-01T00:00:00Z' }),
      writeCache,
      fetch: fetched({ lumen: 'codex' }),
      scope: SCOPE,
    });
    expect(r).toEqual({ backend: 'codex', source: 'server' });
    expect(writeCache).toHaveBeenCalledWith({ backends: { lumen: 'codex' }, ambiguous: [] }, SCOPE);
  });

  it('falls back to a STALE but in-scope cache when the server is unreachable', async () => {
    // A stale answer beats no answer here: no answer means falling through to
    // 'claude', which is the exact bug being fixed.
    const r = await lookupAgentBackend('lumen', {
      readCache: () => cacheOf({ lumen: 'codex' }, { age: '2020-01-01T00:00:00Z' }),
      writeCache: vi.fn(),
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      scope: SCOPE,
    });
    expect(r).toEqual({ backend: 'codex', source: 'cache' });
  });

  it('does NOT use another server’s cache, fresh or stale', async () => {
    // A backend is only meaningful inside the scope that produced it. Pointing
    // the CLI at a different server makes the same slug a different being.
    const other = cacheOf({ lumen: 'codex' }, { scope: OTHER_SERVER });

    const served = await lookupAgentBackend('lumen', {
      readCache: () => other,
      writeCache: vi.fn(),
      fetch: fetched({ lumen: 'claude' }),
      scope: SCOPE,
    });
    expect(served).toEqual({ backend: 'claude', source: 'server' });

    // ...and when the new server is unreachable, the other scope's entry is
    // still not an answer. Inapplicable, not merely stale.
    const offline = await lookupAgentBackend('lumen', {
      readCache: () => other,
      writeCache: vi.fn(),
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      scope: SCOPE,
    });
    expect(offline).toEqual({ source: 'none' });
  });

  it('derives its scope from the environment when none is injected', async () => {
    // Every other lookup test passes `scope` explicitly, which would stay green
    // even if the real env-derived path were broken. This one drives the same
    // switch the way production does — by changing INK_SERVER_URL — so the
    // injected-scope tests above cannot be the only evidence.
    const original = process.env.INK_SERVER_URL;
    let stored: { scope?: object; backends: Record<string, string> } | null = null;
    const readCache = () => (stored ? { fetchedAt: new Date().toISOString(), ...stored } : null);
    const writeCache = (entry: { backends: Record<string, string> }, scope?: object) => {
      stored = { scope, backends: entry.backends };
    };
    try {
      process.env.INK_SERVER_URL = 'https://server-a.example.test';
      const a = await lookupAgentBackend('fixture', {
        readCache,
        writeCache,
        fetch: fetched({ fixture: 'codex' }),
      });
      expect(a.backend).toBe('codex');

      process.env.INK_SERVER_URL = 'https://server-b.example.test';
      const b = await lookupAgentBackend('fixture', {
        readCache,
        writeCache,
        fetch: fetched({ fixture: 'claude' }),
      });
      expect(b.backend, 'server A cache answered for server B').toBe('claude');
    } finally {
      if (original === undefined) delete process.env.INK_SERVER_URL;
      else process.env.INK_SERVER_URL = original;
    }
  });

  it('does NOT use another ACCOUNT\u2019s cache on the same server', async () => {
    // Round 2 recorded a userId and never compared it, so a re-login on the
    // same server still hit the previous account's cache — fresh AND stale.
    // The field made the record look scoped while doing nothing.
    const theirs = cacheOf({ lumen: 'codex' }, { scope: OTHER_ACCOUNT });

    const served = await lookupAgentBackend('lumen', {
      readCache: () => theirs,
      writeCache: vi.fn(),
      fetch: fetched({ lumen: 'claude' }),
      scope: SCOPE,
    });
    expect(served).toEqual({ backend: 'claude', source: 'server' });

    const offline = await lookupAgentBackend('lumen', {
      readCache: () => theirs,
      writeCache: vi.fn(),
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      scope: SCOPE,
    });
    expect(offline, "another account's cache answered").toEqual({ source: 'none' });
  });

  it('fails closed when either side cannot name its principal', async () => {
    // An unauthenticated CLI cannot claim a cache. It costs nothing: it could
    // not have reached the server to fill one either.
    const anonymousNow = await lookupAgentBackend('lumen', {
      readCache: () => cacheOf({ lumen: 'codex' }),
      writeCache: vi.fn(),
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      scope: { serverUrl: SCOPE.serverUrl },
    });
    expect(anonymousNow).toEqual({ source: 'none' });

    const anonymousCache = await lookupAgentBackend('lumen', {
      readCache: () => cacheOf({ lumen: 'codex' }, { scope: { serverUrl: SCOPE.serverUrl } }),
      writeCache: vi.fn(),
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      scope: SCOPE,
    });
    expect(anonymousCache).toEqual({ source: 'none' });
  });

  it('drops a cached backend once the slug becomes ambiguous', async () => {
    // Otherwise the next OFFLINE lookup resurrects an answer the server has
    // already stopped standing behind. (Lumen, #665 r2.)
    let stored = cacheOf({ lumen: 'codex', other: 'claude' }, { age: '2020-01-01T00:00:00Z' });
    const readCache = () => stored;
    const writeCache = (
      entry: { backends: Record<string, string>; ambiguous: string[] },
      scope?: object
    ) => {
      stored = { fetchedAt: new Date().toISOString(), scope, ...entry } as typeof stored;
    };

    const refused = await lookupAgentBackend('lumen', {
      readCache,
      writeCache,
      fetch: fetched({ other: 'claude' }, ['lumen']),
      scope: SCOPE,
    });
    expect(refused.ambiguous).toBe(true);
    expect(stored.backends, 'the stale entry survived the refusal').not.toHaveProperty('lumen');

    const offline = await lookupAgentBackend('lumen', {
      readCache,
      writeCache: vi.fn(),
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      scope: SCOPE,
    });
    expect(offline.backend, 'an ambiguous slug was resurrected offline').toBeUndefined();
  });

  it('keeps the ambiguity marker when another slug repopulates the cache', async () => {
    // Look up 'other', which succeeds and writes the cache. The refusal for
    // 'fixture' travelled in the same response and must land in the cache with
    // it, or the next lookup of 'fixture' degrades from "ambiguous" to silence.
    let stored: unknown = null;
    const readCache = () => stored as never;
    const writeCache = (entry: unknown, scope?: object) => {
      stored = { fetchedAt: new Date().toISOString(), scope, ...(entry as object) };
    };

    await lookupAgentBackend('other', {
      readCache,
      writeCache,
      fetch: fetched({ other: 'claude' }, ['fixture']),
      scope: SCOPE,
    });

    const result = await lookupAgentBackend('fixture', {
      readCache,
      writeCache,
      fetch: vi.fn(), // must not be needed: the cache is fresh and in scope
      scope: SCOPE,
    });
    expect(result.ambiguous, 'the refusal was lost when the cache was written').toBe(true);
  });

  it('caches a real answer even when every slug in it is ambiguous', async () => {
    // An empty map is NOT the old-server signal — all-ambiguous empties it too,
    // and that is a real answer whose absence must reach the cache.
    const writeCache = vi.fn();
    await lookupAgentBackend('lumen', {
      readCache: () => null,
      writeCache,
      fetch: fetched({}, ['lumen']),
      scope: SCOPE,
    });
    expect(writeCache).toHaveBeenCalled();
  });

  it('treats a cache with no recorded scope as inapplicable', async () => {
    // Written before scope existed, or by a writer that did not record one.
    // Either way we cannot say it belongs here.
    const r = await lookupAgentBackend('lumen', {
      readCache: () => cacheOf({ lumen: 'codex' }, { scope: undefined }),
      writeCache: vi.fn(),
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      scope: SCOPE,
    });
    expect(r).toEqual({ source: 'none' });
  });

  it('refuses a slug that names more than one identity', async () => {
    // A slug is unique within ONE workspace, never globally — `echo` has three
    // rows today. Assigning into a map by slug is last-row-wins, which is a
    // guess, and a silent one.
    const r = await lookupAgentBackend('fixture', {
      readCache: () => null,
      writeCache: vi.fn(),
      fetch: fetched({ other: 'codex' }, ['fixture']),
      scope: SCOPE,
    });
    expect(r.backend).toBeUndefined();
    expect(r.ambiguous).toBe(true);
  });

  it('never caches an empty answer from an older server', async () => {
    // A server deployed before list_identities projected the column returns
    // identities with no backend on any of them. Writing that to the cache
    // would keep `ink -a lumen` on claude for a full day after the upgrade.
    const writeCache = vi.fn();
    const r = await lookupAgentBackend('lumen', {
      readCache: () => null,
      writeCache,
      fetch: oldServer(),
      scope: SCOPE,
    });
    expect(writeCache).not.toHaveBeenCalled();
    expect(r).toEqual({ source: 'none' });
  });

  it('keeps a stale cache rather than taking an older server at its word', async () => {
    const writeCache = vi.fn();
    const r = await lookupAgentBackend('lumen', {
      readCache: () => cacheOf({ lumen: 'codex' }, { age: '2020-01-01T00:00:00Z' }),
      writeCache,
      fetch: oldServer(),
      scope: SCOPE,
    });
    expect(writeCache).not.toHaveBeenCalled();
    expect(r).toEqual({ backend: 'codex', source: 'cache' });
  });

  it('reports no answer when offline with no cache at all', async () => {
    const r = await lookupAgentBackend('lumen', {
      readCache: () => null,
      writeCache: vi.fn(),
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      scope: SCOPE,
    });
    expect(r).toEqual({ source: 'none' });
  });

  it('flags a recorded backend this CLI cannot launch, and offers no substitute', async () => {
    const r = await lookupAgentBackend('aster', {
      readCache: () => fresh(),
      fetch: vi.fn(),
      scope: SCOPE,
    });
    expect(r.backend).toBeUndefined();
    expect(r.unrunnable).toBe('antigravity');
  });

  it('returns nothing for an agent with no recorded backend', async () => {
    const r = await lookupAgentBackend('nobody', {
      readCache: () => fresh(),
      fetch: vi.fn(),
      scope: SCOPE,
    });
    expect(r.backend).toBeUndefined();
    expect(r.unrunnable).toBeUndefined();
  });

  it('does not hand back an inherited member for a prototype-named slug', async () => {
    // `ink -a constructor` retrieved Object.prototype.constructor and threw
    // inside normalizeBackendAlias. Same hazard as deprecatedBackendReason
    // (#585) — one file away, and I did not apply the rule here.
    for (const slug of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const r = await lookupAgentBackend(slug, {
        readCache: () => fresh(),
        fetch: vi.fn(),
        scope: SCOPE,
      });
      expect(r.backend, slug).toBeUndefined();
      expect(r.unrunnable, slug).toBeUndefined();
    }
  });

  it('ignores case in the slug', async () => {
    const r = await lookupAgentBackend('LUMEN', {
      readCache: () => fresh(),
      fetch: vi.fn(),
      scope: SCOPE,
    });
    expect(r.backend).toBe('codex');
  });
});
