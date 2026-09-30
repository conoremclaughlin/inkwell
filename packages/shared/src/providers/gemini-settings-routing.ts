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
 * refused, because what it would send is unknown.
 *
 * Only the files the caller names are checked. A layer Gemini reads from
 * elsewhere is not, so this guards those files and makes no claim about
 * Gemini's effective settings.
 */

import { readFile } from 'fs/promises';

const ROUTING_HEADER_NAMES: ReadonlySet<string> = new Set([
  'x-ink-session-id',
  'x-ink-studio-id',
  'x-ink-context',
]);

export type GeminiSettingsFinding =
  | { path: string; kind: 'routing'; /** Header names as written. */ headers: string[] }
  | { path: string; kind: 'unreadable' };

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
              : `${finding.path} cannot be read`
          )
          .join('; ') +
        '. A static routing header is one session’s value, sent for every session. ' +
        'Repair a studio’s workspace settings with `ink init`; remove it by hand from ' +
        'user settings, which ink never rewrites.'
    );
    this.name = 'BakedRoutingHeaderError';
  }
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

/** What each of `paths` would contribute that a named-session spawn refuses. */
export async function findGeminiSettingsRouting(
  paths: readonly string[]
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
    let settings: unknown;
    try {
      settings = JSON.parse(text);
    } catch {
      findings.push({ path, kind: 'unreadable' });
      continue;
    }
    const headers = routingHeaderNames(settings);
    if (headers.length > 0) findings.push({ path, kind: 'routing', headers });
  }
  return findings;
}

/** Reject with BakedRoutingHeaderError when any of `paths` has a finding. */
export async function refuseGeminiSettingsRouting(paths: readonly string[]): Promise<void> {
  const findings = await findGeminiSettingsRouting(paths);
  if (findings.length > 0) throw new BakedRoutingHeaderError('gemini', findings);
}
