/**
 * Which backend an SB actually runs on.
 *
 * `ink -a lumen` used to start Lumen on claude, because the agent flag selected
 * the identity and nothing selected the runtime that identity runs on. Every
 * invocation needed `-b codex` alongside it, for every sibling, forever.
 *
 * The answer already existed: `agent_identities.backend`. It was simply not
 * projected by `list_identities`, so no client could read it — the data was
 * there and the CLI guessed anyway. That projection is added alongside this
 * file; here we read it, normalise it, and cache it.
 *
 * Two things make this more than a lookup:
 *
 * 1. **The stored names are not all CLI backend names.** wren's record says
 *    `claude-code` and benson's says `claude` — the same runtime under two
 *    spellings, because the column has no constraint and different writers used
 *    different vocabularies. `normalizeBackendAlias` collapses them.
 *
 * 2. **Not every stored name is runnable.** aster's record says `antigravity`,
 *    which has no adapter in this CLI at all. Silently falling back would start
 *    Aster on claude and look like it worked. We say so and fall through.
 *
 * The cache exists so the common path costs nothing and works on a plane: a
 * network round-trip on every `ink -a <agent>` would add latency to every
 * launch and, when the server is down, would silently produce the WRONG backend
 * rather than no answer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { callInkTool } from '../lib/ink-mcp.js';

/**
 * Backends this CLI can actually launch: the three adapters plus `ink`, which
 * is handled by the first-class chat runtime rather than an adapter.
 *
 * Deliberately NOT imported from ./index.js — that module imports the adapters,
 * which import identity.ts, which imports this file. `agent-backend.test.ts`
 * asserts this set equals `[...BACKEND_NAMES, 'ink']`, so the duplication is
 * pinned rather than left to drift.
 */
export const RUNNABLE_BACKENDS: readonly string[] = ['claude', 'codex', 'gemini', 'ink'];

/** How long a cached answer is trusted before we try the server again. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Short on purpose. This sits in front of every `ink -a <agent>` launch, so a
 * hung server must cost a beat, not a wait — and we have a cache to fall back
 * on.
 */
const FETCH_TIMEOUT_MS = 2500;

export interface AgentBackendCache {
  fetchedAt: string;
  backends: Record<string, string>;
}

export function agentBackendCachePath(): string {
  return join(homedir(), '.ink', 'agent-backends.json');
}

/**
 * Collapse the spellings the identity column has accumulated onto the names
 * this CLI dispatches by. Mirrors the alias handling already in
 * `resolveSlug` (identity.ts), which maps the same pairs in the other
 * direction.
 */
export function normalizeBackendAlias(raw: string | null | undefined): string | undefined {
  const value = (raw ?? '').toLowerCase().trim();
  if (!value) return undefined;
  switch (value) {
    case 'claude-code':
    case 'claude-cli':
      return 'claude';
    case 'codex-cli':
      return 'codex';
    case 'gemini-cli':
      return 'gemini';
    default:
      return value;
  }
}

export function isRunnableBackend(name: string | undefined): boolean {
  return !!name && RUNNABLE_BACKENDS.includes(name);
}

export function readAgentBackendCache(path = agentBackendCachePath()): AgentBackendCache | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as AgentBackendCache;
    if (!parsed || typeof parsed.backends !== 'object' || parsed.backends === null) return null;
    return parsed;
  } catch {
    // A corrupt cache is a cache miss, never a crash on the launch path.
    return null;
  }
}

export function writeAgentBackendCache(
  backends: Record<string, string>,
  path = agentBackendCachePath()
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ fetchedAt: new Date().toISOString(), backends }, null, 2),
      'utf-8'
    );
  } catch {
    // Best effort. Failing to cache is not a reason to fail the launch.
  }
}

export function isCacheFresh(cache: AgentBackendCache | null, now = Date.now()): boolean {
  if (!cache?.fetchedAt) return false;
  const age = now - new Date(cache.fetchedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS;
}

interface IdentityRow {
  sbSlug?: string;
  backend?: string | null;
}

/** Ask the server for every identity's backend. Throws on any failure. */
export async function fetchAgentBackends(): Promise<Record<string, string>> {
  const result = await callInkTool<{ identities?: IdentityRow[] }>(
    'list_identities',
    {},
    { timeoutMs: FETCH_TIMEOUT_MS, callerProfile: 'runtime' }
  );
  const backends: Record<string, string> = {};
  for (const row of result.identities ?? []) {
    const slug = row.sbSlug?.trim();
    // Store the RAW value. Normalising on write would bake today's alias table
    // into the cache file, where a later fix could not reach it.
    if (slug && typeof row.backend === 'string' && row.backend.trim()) {
      backends[slug] = row.backend.trim();
    }
  }
  return backends;
}

export interface AgentBackendLookup {
  /** Normalised and runnable, or undefined when we have no usable answer. */
  backend?: string;
  source: 'cache' | 'server' | 'none';
  /** Set when a backend was recorded but this CLI cannot launch it. */
  unrunnable?: string;
}

/**
 * Look up one agent's backend, preferring a fresh cache and falling back to a
 * stale one when the server cannot be reached. A stale answer beats no answer:
 * an SB's runtime changes about once a year, and the alternative is silently
 * launching them on the wrong one.
 */
export async function lookupAgentBackend(
  agentSlug: string,
  deps: {
    readCache?: typeof readAgentBackendCache;
    writeCache?: typeof writeAgentBackendCache;
    fetch?: typeof fetchAgentBackends;
    now?: number;
  } = {}
): Promise<AgentBackendLookup> {
  const readCache = deps.readCache ?? readAgentBackendCache;
  const writeCache = deps.writeCache ?? writeAgentBackendCache;
  const fetch = deps.fetch ?? fetchAgentBackends;
  const slug = agentSlug.trim().toLowerCase();
  if (!slug) return { source: 'none' };

  const cached = readCache();
  if (isCacheFresh(cached, deps.now) && cached) {
    return classify(cached.backends[slug], 'cache');
  }

  try {
    const fresh = await fetch();
    if (Object.keys(fresh).length === 0) {
      // The server answered, and named no backends at all. That is what an
      // older server looks like — one deployed before `list_identities`
      // projected the column. Caching it would pin "nobody has a backend" for
      // a full day, so `ink -a lumen` would keep starting claude for 24 hours
      // AFTER the server was upgraded. Treat it exactly like a failed fetch.
      if (cached) return classify(cached.backends[slug], 'cache');
      return { source: 'none' };
    }
    writeCache(fresh);
    return classify(fresh[slug], 'server');
  } catch {
    // Offline, unauthenticated, or the server is down. A stale cache is still
    // the best information anyone has.
    if (cached) return classify(cached.backends[slug], 'cache');
    return { source: 'none' };
  }
}

function classify(raw: string | undefined, source: 'cache' | 'server'): AgentBackendLookup {
  const normalized = normalizeBackendAlias(raw);
  if (!normalized) return { source };
  if (!isRunnableBackend(normalized)) return { source, unrunnable: normalized };
  return { backend: normalized, source };
}
