/**
 * Refusal for a named-session Gemini spawn whose settings files would send a
 * routing header that is not the spawn's own.
 *
 * Gemini reads MCP headers from settings the adapter does not write: the
 * studio's workspace settings and the user's own. A routing header (which
 * session and studio a request serves) baked into either is one session's
 * value, sent for every session that runs there. Syncs wrote them into
 * workspace settings until 2026-09-29, and a user can add them by hand. How
 * Gemini merges those files with the system settings the adapter writes is
 * unverified, so the spawn refuses rather than relying on that merge. It
 * never rewrites the files: a user's settings are not ink's to change.
 *
 * Only header NAMES under `mcpServers.<name>.headers` count, read from the
 * parsed file, so a routing name in a value, a description or an env map is
 * not one, and no header value is ever read into a message. A file that is
 * absent carries nothing; one that exists and cannot be read or parsed is
 * refused, because what it would send is unknown. It is parsed as Gemini
 * parses it: `//` and block comments outside strings are removed, then the
 * rest must be strict JSON, so a trailing comma is still unreadable (Myra,
 * measured on gemini 0.54.0, #701 4705eab0).
 *
 * Only the files the caller names are checked. A layer Gemini reads from
 * elsewhere is not, so this guards those files and makes no claim about
 * Gemini's effective settings.
 */

import { readFile } from 'fs/promises';
import { comparableOrigin, parseUrl } from './inkwell-origin.js';

const ROUTING_HEADER_NAMES: ReadonlySet<string> = new Set([
  'x-ink-session-id',
  'x-ink-studio-id',
  'x-ink-context',
]);

export type GeminiSettingsFinding =
  | { path: string; kind: 'routing'; /** Header names as written. */ headers: string[] }
  | { path: string; kind: 'unreadable' }
  | { path: string; kind: 'foreign-session-env' };

/**
 * The session a spawn serves, for the rule on servers other than Inkwell:
 * Gemini expands env references in every string of its loaded settings
 * (resolveEnvVarsInObject) from the env it runs with, so a foreign server
 * whose config names a session var anywhere is handed the session's value.
 * Measured on 0.54.0 in headers, env, `httpUrl` and stdio `args`, including
 * the `${NAME:-default}` spelling (Myra, #701 aebf2020, c1f12ae1).
 */
export interface GeminiSessionScope {
  /** This session's Inkwell MCP server, from the host. */
  inkwellMcpUrl: string;
  /** The names of the env vars the spawn carries for the session. */
  sessionEnvNames: Iterable<string>;
}

/**
 * Gemini 0.54.0's own reference pattern: `$NAME`, `${NAME}` and
 * `${NAME:-default}`, the name in the first or second group.
 */
const ENV_REFERENCE = /\$(?:(\w+)|\{([^}]+?)(?::-[^}]*)?\})/g;

function referencedNames(value: string): string[] {
  return [...value.matchAll(ENV_REFERENCE)].map((match) => (match[1] ?? match[2])!);
}

/** Every string value anywhere in `value`, however deep. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isRecord(value)) return Object.values(value).flatMap(stringsIn);
  return [];
}

export class BakedRoutingHeaderError extends Error {
  constructor(
    readonly backend: string,
    readonly findings: GeminiSettingsFinding[]
  ) {
    super(
      `${backend}: refusing a spawn for a named session. ` +
        findings
          .map((finding) =>
            finding.kind === 'routing'
              ? `${finding.path} sets ${finding.headers.join(', ')}`
              : finding.kind === 'foreign-session-env'
                ? `${finding.path} has an MCP server other than Inkwell drawing a session value from the environment`
                : `${finding.path} cannot be read`
          )
          .join('; ') +
        '. A static routing header is one session’s value, sent for every session, and a ' +
        'server other than Inkwell must not be handed the session’s credentials or routing. ' +
        'Repair a studio’s workspace settings with `ink init`; remove it by hand from ' +
        'user settings, which ink never rewrites.'
    );
    this.name = 'BakedRoutingHeaderError';
  }
}

/**
 * `text` with its `//` and block comments removed, outside strings only, so
 * the `//` in a URL value stays. Each comment becomes a space, keeping
 * tokens apart; a line comment keeps its newline. Undefined when a block
 * comment never closes.
 */
function withoutComments(text: string): string | undefined {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        // An escaped character, `\"` included, never ends the string.
        i += 1;
        out += text[i] ?? '';
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      out += ' ';
      i = (newline === -1 ? text.length : newline) - 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return undefined;
      out += ' ';
      i = close + 1;
    } else {
      out += ch;
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Routing header names under `mcpServers.*.headers`, as written, first seen first. */
function routingHeaderNames(settings: unknown): string[] {
  if (!isRecord(settings) || !isRecord(settings.mcpServers)) return [];
  const found = new Set<string>();
  for (const server of Object.values(settings.mcpServers)) {
    if (!isRecord(server) || !isRecord(server.headers)) continue;
    for (const name of Object.keys(server.headers)) {
      if (ROUTING_HEADER_NAMES.has(name.toLowerCase())) found.add(name);
    }
  }
  return [...found];
}

/**
 * Whether any server other than Inkwell draws a session var through any
 * string in its config. A server is Inkwell when its `httpUrl` or `url` has
 * the origin of the host's Inkwell URL, loopback aliases folded. One with no
 * readable URL (a stdio server included), or whose URL itself holds a
 * reference, is not: the comparison sees the unexpanded URL, and an
 * expansion can change its host (Myra, c1f12ae1).
 */
function drawsSessionEnvOffInkwell(settings: unknown, scope: GeminiSessionScope): boolean {
  if (!isRecord(settings) || !isRecord(settings.mcpServers)) return false;
  const inkwell = parseUrl(scope.inkwellMcpUrl);
  const inkwellOrigin = inkwell ? comparableOrigin(inkwell) : undefined;
  const sessionVars = new Set(scope.sessionEnvNames);
  for (const server of Object.values(settings.mcpServers)) {
    if (!isRecord(server)) continue;
    const rawUrl = typeof server.httpUrl === 'string' ? server.httpUrl : server.url;
    const url = typeof rawUrl === 'string' && !rawUrl.includes('$') ? parseUrl(rawUrl) : undefined;
    if (url && inkwellOrigin !== undefined && comparableOrigin(url) === inkwellOrigin) continue;
    const drawn = stringsIn(server).flatMap(referencedNames);
    if (drawn.some((name) => sessionVars.has(name))) return true;
  }
  return false;
}

/**
 * What each of `paths` would contribute that a named-session spawn refuses.
 * With `scope`, a server other than Inkwell drawing a session var is one
 * too.
 */
export async function findGeminiSettingsRouting(
  paths: readonly string[],
  scope?: GeminiSessionScope
): Promise<GeminiSettingsFinding[]> {
  const findings: GeminiSettingsFinding[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      findings.push({ path, kind: 'unreadable' });
      continue;
    }
    const json = withoutComments(text);
    let settings: unknown;
    try {
      if (json === undefined) throw new Error('unterminated comment');
      settings = JSON.parse(json);
    } catch {
      findings.push({ path, kind: 'unreadable' });
      continue;
    }
    const headers = routingHeaderNames(settings);
    if (headers.length > 0) findings.push({ path, kind: 'routing', headers });
    if (scope && drawsSessionEnvOffInkwell(settings, scope)) {
      findings.push({ path, kind: 'foreign-session-env' });
    }
  }
  return findings;
}

/** Reject with BakedRoutingHeaderError when any of `paths` has a finding. */
export async function refuseGeminiSettingsRouting(paths: readonly string[]): Promise<void> {
  const findings = await findGeminiSettingsRouting(paths);
  if (findings.length > 0) throw new BakedRoutingHeaderError('gemini', findings);
}
