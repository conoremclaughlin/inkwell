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
} from './agent-backend.js';
import { BACKEND_NAMES } from './index.js';

const SCOPE = { serverUrl: 'https://server-a.example.test' };
const OTHER_SCOPE = { serverUrl: 'https://server-b.example.test' };

/** A fetch result in the shape the server path returns. */
const fetched = (backends: Record<string, string>, ambiguous: string[] = []) =>
  vi.fn().mockResolvedValue({ backends, ambiguous, userId: 'user-1' });

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
    writeAgentBackendCache({ lumen: 'codex' }, { ...SCOPE, userId: 'user-1' }, path);
    const back = readAgentBackendCache(path);
    expect(back?.backends).toEqual({ lumen: 'codex' });
    expect(back?.scope).toEqual({ ...SCOPE, userId: 'user-1' });
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

  it('creates the directory when ~/.ink does not exist yet', () => {
    const path = join(dir, 'nested', 'agent-backends.json');
    writeAgentBackendCache({ wren: 'claude-code' }, SCOPE, path);
    expect(existsSync(path)).toBe(true);
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
    expect(writeCache).toHaveBeenCalledWith({ lumen: 'codex' }, { ...SCOPE, userId: 'user-1' });
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
    const other = cacheOf({ lumen: 'codex' }, { scope: OTHER_SCOPE });

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
    const writeCache = (backends: Record<string, string>, scope?: object) => {
      stored = { scope, backends };
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
      fetch: fetched({}),
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
      fetch: fetched({}),
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
