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
  /**
   * Which server and account the map came from. A cached backend is only
   * meaningful inside the scope that produced it: point the CLI at a different
   * server, or authenticate as a different account, and the same slug is a
   * different being. Without this the CLI answered for server B out of server
   * A's cache. (Lumen, #665 r1.)
   */
  scope?: { serverUrl: string; userId?: string };
  backends: Record<string, string>;
}

export interface AgentBackendFetch {
  backends: Record<string, string>;
  /** Slugs that resolved to more than one identity — deliberately unanswerable. */
  ambiguous: string[];
  userId?: string;
}

/**
 * The scope the current process is operating in.
 *
 * Reads the environment directly rather than calling ink-mcp's
 * `getInkServerUrl`. That module also does HTTP, auth and error formatting, so
 * every test that wants to control `callInkTool` mocks it — and an incidental
 * import for one line of env read then breaks those tests with an error about
 * a missing export, nowhere near the behaviour under test. Lumen's review
 * probe hit exactly that. `currentScope.test` pins this against the real
 * getInkServerUrl so the duplicated default cannot drift.
 */
export function currentScope(): { serverUrl: string } {
  return { serverUrl: process.env.INK_SERVER_URL || 'http://localhost:3001' };
}

function sameScope(cached: AgentBackendCache['scope'], now: { serverUrl: string }): boolean {
  // An unscoped cache is from before this field existed, or from a writer that
  // did not record one. Either way we cannot say it belongs here.
  return !!cached && cached.serverUrl === now.serverUrl;
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
    // Well-formed JSON is not a well-formed cache. A value that is not a string
    // reaches normalizeBackendAlias and throws on .toLowerCase() — on the
    // launch path, for every command. Syntactic validity was the only thing
    // checked here before. (Lumen, #665 r1.)
    for (const value of Object.values(parsed.backends)) {
      if (typeof value !== 'string') return null;
    }
    return parsed;
  } catch {
    // A corrupt cache is a cache miss, never a crash on the launch path.
    return null;
  }
}

export function writeAgentBackendCache(
  backends: Record<string, string>,
  scope?: { serverUrl: string; userId?: string },
  path = agentBackendCachePath()
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ fetchedAt: new Date().toISOString(), scope, backends }, null, 2),
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
  id?: string;
  sbSlug?: string;
  backend?: string | null;
}

/**
 * Ask the server for every identity's backend. Throws on any failure.
 *
 * `list_identities` is called unscoped, so a slug that exists in more than one
 * workspace comes back more than once — `echo` has three rows today. A slug is
 * unique within ONE workspace, never globally, and AGENTS.md is explicit that
 * resolution "refuses rather than guessing when a slug is ambiguous". Assigning
 * into a map by slug is guessing: last row wins, silently, and which row is
 * last is whatever order the server returned.
 *
 * So ambiguous slugs are collected and excluded rather than resolved. Falling
 * through to identity.json is a worse answer than the right one and a better
 * answer than an arbitrary one. (Lumen, #665 r1.)
 */
export async function fetchAgentBackends(): Promise<AgentBackendFetch> {
  const result = await callInkTool<{ identities?: IdentityRow[]; user?: { id?: string } }>(
    'list_identities',
    {},
    { timeoutMs: FETCH_TIMEOUT_MS, callerProfile: 'runtime' }
  );

  const seen = new Map<string, string | null>();
  const ambiguous = new Set<string>();
  for (const row of result.identities ?? []) {
    const slug = row.sbSlug?.trim().toLowerCase();
    if (!slug) continue;
    // Store the RAW value. Normalising on write would bake today's alias table
    // into the cache file, where a later fix could not reach it.
    const backend =
      typeof row.backend === 'string' && row.backend.trim() ? row.backend.trim() : null;
    if (seen.has(slug)) {
      ambiguous.add(slug);
      continue;
    }
    seen.set(slug, backend);
  }

  const backends: Record<string, string> = Object.create(null);
  for (const [slug, backend] of seen) {
    if (backend && !ambiguous.has(slug)) backends[slug] = backend;
  }
  return { backends, ambiguous: [...ambiguous], userId: result.user?.id };
}

export interface AgentBackendLookup {
  /** Normalised and runnable, or undefined when we have no usable answer. */
  backend?: string;
  source: 'cache' | 'server' | 'none';
  /** Set when a backend was recorded but this CLI cannot launch it. */
  unrunnable?: string;
  /** Set when the slug names more than one identity and we refused to pick. */
  ambiguous?: boolean;
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
    scope?: { serverUrl: string };
  } = {}
): Promise<AgentBackendLookup> {
  const readCache = deps.readCache ?? readAgentBackendCache;
  const writeCache = deps.writeCache ?? writeAgentBackendCache;
  const fetch = deps.fetch ?? fetchAgentBackends;
  const scope = deps.scope ?? currentScope();
  const slug = agentSlug.trim().toLowerCase();
  if (!slug) return { source: 'none' };

  const cached = readCache();
  // A cache from another server or account answers a different question, so it
  // is a miss here — not stale, inapplicable. This is checked on the fresh path
  // AND on the stale-fallback path below: "stale but ours" is useful, "fresh
  // but somebody else's" never is.
  const usable = cached && sameScope(cached.scope, scope) ? cached : null;

  if (usable && isCacheFresh(usable, deps.now)) {
    return classify(pick(usable.backends, slug), 'cache');
  }

  try {
    const fresh = await fetch();
    // Tolerate a malformed result instead of letting a property access throw
    // into the catch below, where a shape problem would be indistinguishable
    // from the server being down.
    const ambiguous = fresh?.ambiguous ?? [];
    const backends = fresh?.backends ?? {};
    if (ambiguous.includes(slug)) {
      return { source: 'server', ambiguous: true };
    }
    if (Object.keys(backends).length === 0) {
      // The server answered, and named no backends at all. That is what an
      // older server looks like — one deployed before `list_identities`
      // projected the column. Caching it would pin "nobody has a backend" for
      // a full day, so `ink -a lumen` would keep starting claude for 24 hours
      // AFTER the server was upgraded. Treat it exactly like a failed fetch.
      if (usable) return classify(pick(usable.backends, slug), 'cache');
      return { source: 'none' };
    }
    writeCache(backends, { ...scope, userId: fresh?.userId });
    return classify(pick(backends, slug), 'server');
  } catch {
    // Offline, unauthenticated, or the server is down. A stale cache from THIS
    // scope is still the best information anyone has.
    if (usable) return classify(pick(usable.backends, slug), 'cache');
    return { source: 'none' };
  }
}

/**
 * Own properties only. An ordinary object indexed by arbitrary input hands back
 * inherited members — `ink -a constructor` would otherwise retrieve
 * Object.prototype.constructor and throw inside normalizeBackendAlias. Same
 * hazard Lumen fixed in deprecatedBackendReason (#585); the rule was one file
 * away and I did not apply it here.
 */
function pick(backends: Record<string, string>, slug: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(backends, slug) ? backends[slug] : undefined;
}

function classify(raw: string | undefined, source: 'cache' | 'server'): AgentBackendLookup {
  const normalized = normalizeBackendAlias(raw);
  if (!normalized) return { source };
  if (!isRunnableBackend(normalized)) return { source, unrunnable: normalized };
  return { backend: normalized, source };
}
