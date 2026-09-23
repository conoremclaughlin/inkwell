/**
 * `ink -a lumen` started Lumen on claude. The agent flag picked the identity
 * and nothing picked the runtime, so every launch needed `-b` alongside it.
 *
 * The task that filed this asked for all THREE levels of the resolution order
 * to be exercised, not just the happy path, because "a default that silently
 * loses to a stale global default would look identical to working, from one
 * test". So the order tests below pin each layer and the precedence between
 * them, and the lookup tests cover the two ways the stored value can be
 * unusable — an alias this CLI does not dispatch by, and a backend it has no
 * adapter for at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
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
} from './agent-backend.js';
import { BACKEND_NAMES } from './index.js';

describe('RUNNABLE_BACKENDS', () => {
  it('agrees with the adapter registry plus the ink runtime', () => {
    // agent-backend.ts cannot import ./index.js — that would close an import
    // cycle through the adapters — so it restates the set. This test is what
    // stops the restatement drifting when an adapter is added or removed.
    expect([...RUNNABLE_BACKENDS].sort()).toEqual([...BACKEND_NAMES, 'ink'].sort());
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
    expect(isCacheFresh({ fetchedAt: '2026-09-22T00:00:00Z', backends: {} }, now)).toBe(true);
  });
  it('rejects one older than the day', () => {
    expect(isCacheFresh({ fetchedAt: '2026-09-20T00:00:00Z', backends: {} }, now)).toBe(false);
  });
  it('rejects a missing, malformed or future stamp', () => {
    expect(isCacheFresh(null, now)).toBe(false);
    expect(isCacheFresh({ fetchedAt: 'not a date', backends: {} }, now)).toBe(false);
    expect(isCacheFresh({ fetchedAt: '2030-01-01T00:00:00Z', backends: {} }, now)).toBe(false);
  });
});

describe('cache file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ink-agent-backend-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips', () => {
    const path = join(dir, 'agent-backends.json');
    writeAgentBackendCache({ lumen: 'codex' }, path);
    expect(readAgentBackendCache(path)?.backends).toEqual({ lumen: 'codex' });
  });

  it('treats a corrupt file as a miss instead of throwing on the launch path', () => {
    const path = join(dir, 'agent-backends.json');
    writeFileSync(path, '{ not json', 'utf-8');
    expect(readAgentBackendCache(path)).toBeNull();
  });

  it('creates the directory when ~/.ink does not exist yet', () => {
    const path = join(dir, 'nested', 'agent-backends.json');
    writeAgentBackendCache({ wren: 'claude-code' }, path);
    expect(existsSync(path)).toBe(true);
  });
});

describe('lookupAgentBackend', () => {
  const fresh = () => ({
    fetchedAt: new Date().toISOString(),
    backends: { lumen: 'codex', wren: 'claude-code', aster: 'antigravity' },
  });

  it('answers from a fresh cache without calling the server', () => {
    const fetch = vi.fn();
    return lookupAgentBackend('lumen', { readCache: () => fresh(), fetch }).then((r) => {
      expect(r).toEqual({ backend: 'codex', source: 'cache' });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('normalises on read, so a fixed alias table reaches old cache files', async () => {
    // The cache stores the RAW value on purpose. If it stored 'claude' we
    // could never correct a mapping without everyone deleting their cache.
    const r = await lookupAgentBackend('wren', { readCache: () => fresh(), fetch: vi.fn() });
    expect(r.backend).toBe('claude');
  });

  it('fetches and caches when the cache is stale', async () => {
    const stale = { fetchedAt: '2020-01-01T00:00:00Z', backends: { lumen: 'claude' } };
    const writeCache = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ lumen: 'codex' });
    const r = await lookupAgentBackend('lumen', { readCache: () => stale, writeCache, fetch });
    expect(r).toEqual({ backend: 'codex', source: 'server' });
    expect(writeCache).toHaveBeenCalledWith({ lumen: 'codex' });
  });

  it('falls back to a STALE cache when the server is unreachable', async () => {
    // A stale answer beats no answer here: no answer means falling through to
    // 'claude', which is the exact bug being fixed.
    const stale = { fetchedAt: '2020-01-01T00:00:00Z', backends: { lumen: 'codex' } };
    const r = await lookupAgentBackend('lumen', {
      readCache: () => stale,
      writeCache: vi.fn(),
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    expect(r).toEqual({ backend: 'codex', source: 'cache' });
  });

  it('never caches an empty answer from an older server', async () => {
    // A server deployed before list_identities projected the column returns
    // identities with no backend on any of them. Writing that to the cache
    // would keep `ink -a lumen` on claude for a full day after the upgrade.
    const writeCache = vi.fn();
    const r = await lookupAgentBackend('lumen', {
      readCache: () => null,
      writeCache,
      fetch: vi.fn().mockResolvedValue({}),
    });
    expect(writeCache).not.toHaveBeenCalled();
    expect(r).toEqual({ source: 'none' });
  });

  it('keeps a stale cache rather than taking an older server at its word', async () => {
    const writeCache = vi.fn();
    const r = await lookupAgentBackend('lumen', {
      readCache: () => ({ fetchedAt: '2020-01-01T00:00:00Z', backends: { lumen: 'codex' } }),
      writeCache,
      fetch: vi.fn().mockResolvedValue({}),
    });
    expect(writeCache).not.toHaveBeenCalled();
    expect(r).toEqual({ backend: 'codex', source: 'cache' });
  });

  it('reports no answer when offline with no cache at all', async () => {
    const r = await lookupAgentBackend('lumen', {
      readCache: () => null,
      writeCache: vi.fn(),
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    expect(r).toEqual({ source: 'none' });
  });

  it('flags a recorded backend this CLI cannot launch, and offers no substitute', async () => {
    const r = await lookupAgentBackend('aster', { readCache: () => fresh(), fetch: vi.fn() });
    expect(r.backend).toBeUndefined();
    expect(r.unrunnable).toBe('antigravity');
  });

  it('returns nothing for an agent with no recorded backend', async () => {
    const r = await lookupAgentBackend('nobody', { readCache: () => fresh(), fetch: vi.fn() });
    expect(r.backend).toBeUndefined();
    expect(r.unrunnable).toBeUndefined();
  });

  it('ignores case in the slug', async () => {
    const r = await lookupAgentBackend('LUMEN', { readCache: () => fresh(), fetch: vi.fn() });
    expect(r.backend).toBe('codex');
  });
});
