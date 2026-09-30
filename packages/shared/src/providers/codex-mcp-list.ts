/**
 * The Codex effective-config check: what `codex mcp list --json` reports,
 * judged before a Codex spawn.
 *
 * Codex merges its config layers (user, trusted project, `-c` overrides), and
 * a `-c` table merges into a configured one rather than replacing it (Lumen,
 * measured on 0.158.0). So the per-session headers the adapter supplies cannot
 * displace a header a config file already sets. This refuses the spawn when
 * the merged result carries one that would misroute or misidentify the
 * session:
 *
 * - a session routing header as a static value, on any server: one session's
 *   value sent for every session (studios synced before 3e49d4b1 carry these);
 * - a server other than Inkwell that draws any of the session's env vars,
 *   through `bearer_token_env_var`, an `env_http_headers` value or a stdio
 *   server's `env_vars`: the session's token or routing sent to someone
 *   else, under whatever header name (Myra, #701 9bd3f8a9);
 * - on Inkwell, an env-drawn routing header that is not exactly one the
 *   adapter sets (same bytes, same var): a `-c` table merges, so a
 *   differently cased or differently sourced key survives beside the
 *   adapter's; and an env-drawn Authorization, since Inkwell's auth comes
 *   only through `bearer_token_env_var`;
 * - a static Authorization for the Inkwell server: a fixed identity in place
 *   of the session's own token;
 * - any header helper: its output is invisible to `mcp list`, so nothing it
 *   sends can be checked;
 * - a server named `inkwell` that is not at the Inkwell server this session
 *   was given: the adapter's own `-c` overrides attach the session's token
 *   and routing to whatever server carries that name.
 *
 * The listing prints static header VALUES in the clear (Myra, 7ca2a2d1), so
 * of static headers only the names are read. `bearer_token_env_var`, the
 * values of `env_http_headers` and a stdio server's `env_vars` are env var
 * NAMES, and are read as such. Every refusal is a fixed string, and nothing
 * from the listing, including a parse error that could quote it, reaches a
 * reason.
 *
 * The shape is pinned to what codex-cli 0.158.0 printed. Anything else is
 * refused as drift rather than guessed at.
 */

import { INK_ENV_HEADERS } from './codex-env-headers.js';
import { comparableOrigin, parseUrl } from './inkwell-origin.js';

export const CODEX_MCP_LIST_MEASURED_AGAINST = 'codex-cli 0.158.0';

/**
 * The repair, both halves. `ink mcp sync` rewrites only ink's managed block
 * in the studio's `.codex/config.toml` (mergeCodexConfig keeps everything
 * outside it), and never touches the user's own config. The listing shows
 * the merged result, not which file a key came from, so the reason names
 * both.
 */
const CODEX_CONFIG_HAND_EDIT =
  "remove it by hand from the studio's `.codex/config.toml` outside ink's managed block, or from `~/.codex/config.toml` (`$CODEX_HOME/config.toml`)";

const CODEX_CONFIG_REPAIR = `run \`ink mcp sync\` in this studio; if the refusal remains, ${CODEX_CONFIG_HAND_EDIT}`;

export const CODEX_CONFIG_REFUSALS = {
  drift: `\`codex mcp list --json\` did not have the shape measured against ${CODEX_MCP_LIST_MEASURED_AGAINST}; Codex was not started, because its MCP configuration could not be checked`,
  staticRouting: `a session routing header is configured in the Codex config; ${CODEX_CONFIG_REPAIR}`,
  // The sync never writes these three, so only the hand edit repairs them
  // (Myra, #701 5f569213).
  foreignSessionEnv: `an MCP server other than Inkwell in the Codex config draws a session credential or routing value from the environment; ${CODEX_CONFIG_HAND_EDIT}`,
  inkwellEnvHeader: `the Codex config sets an Inkwell routing or Authorization header from the environment that ink does not own; ${CODEX_CONFIG_REPAIR}`,
  staticAuthorization: `a static Authorization header is configured for the Inkwell MCP server in the Codex config; ${CODEX_CONFIG_HAND_EDIT}`,
  helper: `an MCP server in the Codex config computes its headers with http_headers_helper, which cannot be checked; ${CODEX_CONFIG_HAND_EDIT}`,
  inkwellElsewhere: `the Codex config's \`inkwell\` MCP server is not this session's Inkwell server; ${CODEX_CONFIG_REPAIR}`,
  unreadableUrl: 'an MCP server in the Codex config has a URL that cannot be read',
  unreadableInkwellUrl: 'the Inkwell server URL this session was given cannot be read',
} as const;

export type CodexConfigRefusal = (typeof CODEX_CONFIG_REFUSALS)[keyof typeof CODEX_CONFIG_REFUSALS];

/** Header names that carry one session's routing (the adapter's, per spawn). */
const ROUTING_HEADER_NAMES: ReadonlySet<string> = new Set([
  'x-ink-session-id',
  'x-ink-studio-id',
  'x-ink-context',
]);

/**
 * Env-drawn header names on Inkwell that only the adapter may set: its own
 * (each admitted only as it writes it) and Authorization.
 */
const INKWELL_OWNED_ENV_HEADERS: ReadonlySet<string> = new Set([
  ...INK_ENV_HEADERS.map(({ header }) => header.toLowerCase()),
  ...ROUTING_HEADER_NAMES,
  'authorization',
]);

type HeaderMap = Record<string, unknown> | null;

/** The server name the Codex adapter's `-c` overrides write to. */
const INKWELL_SERVER_NAME = 'inkwell';

interface HttpTransport {
  name: string;
  url: string;
  bearerTokenEnvVar: string | null;
  httpHeaders: HeaderMap;
  /** Header name to the NAME of the env var it is drawn from. */
  envHttpHeaders: Record<string, string> | null;
  helper: string | null;
}

export interface CodexMcpListJudgement {
  /** The Inkwell server this session was given by its host. */
  inkwellMcpUrl: string;
  /** The names of the env vars the session's spawn carries for the session. */
  sessionEnvNames: Iterable<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHeaderMap(value: unknown): value is HeaderMap {
  return value === null || isRecord(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableStringMap(value: unknown): value is Record<string, string> | null {
  return (
    value === null || (isRecord(value) && Object.values(value).every((v) => typeof v === 'string'))
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * The HTTP transport's fields, or undefined when its shape is not 0.158.0's:
 * all five keys present, each null when unset. An absent key reads as
 * `undefined`, which no field's check admits.
 */
function readHttpTransport(
  name: string,
  transport: Record<string, unknown>
): HttpTransport | undefined {
  const { url, bearer_token_env_var, http_headers, env_http_headers, http_headers_helper } =
    transport;
  if (
    typeof url !== 'string' ||
    !isNullableString(bearer_token_env_var) ||
    !isHeaderMap(http_headers) ||
    !isNullableStringMap(env_http_headers) ||
    !isNullableString(http_headers_helper)
  ) {
    return undefined;
  }
  return {
    name,
    url,
    bearerTokenEnvVar: bearer_token_env_var,
    httpHeaders: http_headers,
    envHttpHeaders: env_http_headers,
    helper: http_headers_helper,
  };
}

function headerNames(map: HeaderMap): string[] {
  return map ? Object.keys(map).map((name) => name.toLowerCase()) : [];
}

/** Whether an env-drawn header on Inkwell is exactly one the adapter writes. */
function isAdapterEnvHeader(header: string, envVar: string): boolean {
  return INK_ENV_HEADERS.some((entry) => entry.header === header && entry.envVar === envVar);
}

/**
 * Judge the stdout of `codex mcp list --json`. Returns the fixed reason to
 * refuse the spawn, or undefined when the effective config is safe to run.
 *
 * `inkwellMcpUrl` is the Inkwell server this session was given by its host,
 * never read from the config under check: a config pointing its `inkwell`
 * entry elsewhere must not move what counts as Inkwell. `sessionEnvNames`
 * are the names the spawn's env actually carries for the session, taken from
 * that env rather than listed by hand.
 */
export function judgeCodexMcpList(
  stdout: string,
  { inkwellMcpUrl, sessionEnvNames }: CodexMcpListJudgement
): CodexConfigRefusal | undefined {
  const inkwell = parseUrl(inkwellMcpUrl);
  if (!inkwell) return CODEX_CONFIG_REFUSALS.unreadableInkwellUrl;
  const inkwellOrigin = comparableOrigin(inkwell);
  const sessionVars = new Set(sessionEnvNames);

  let servers: unknown;
  try {
    servers = JSON.parse(stdout);
  } catch {
    // The parse error can quote the input, which can hold a header value.
    return CODEX_CONFIG_REFUSALS.drift;
  }
  if (!Array.isArray(servers)) return CODEX_CONFIG_REFUSALS.drift;

  let refusal: CodexConfigRefusal | undefined;
  // Every entry is shape-checked before any header rule is applied, so
  // drift anywhere is reported as drift. Disabled servers are judged too.
  const transports: HttpTransport[] = [];
  for (const server of servers) {
    if (!isRecord(server) || typeof server.name !== 'string' || !isRecord(server.transport)) {
      return CODEX_CONFIG_REFUSALS.drift;
    }
    const { type } = server.transport;
    if (type === 'stdio') {
      // Never Inkwell. `env_vars` names parent env vars the server is
      // handed; [] on every 0.158.0 entry measured.
      const { env_vars } = server.transport;
      if (!isStringArray(env_vars)) return CODEX_CONFIG_REFUSALS.drift;
      if (server.name === INKWELL_SERVER_NAME) refusal ??= CODEX_CONFIG_REFUSALS.inkwellElsewhere;
      if (env_vars.some((name) => sessionVars.has(name))) {
        refusal ??= CODEX_CONFIG_REFUSALS.foreignSessionEnv;
      }
      continue;
    }
    if (type !== 'streamable_http') return CODEX_CONFIG_REFUSALS.drift;
    const transport = readHttpTransport(server.name, server.transport);
    if (!transport) return CODEX_CONFIG_REFUSALS.drift;
    transports.push(transport);
  }

  for (const transport of transports) {
    const url = parseUrl(transport.url);
    if (!url) return CODEX_CONFIG_REFUSALS.unreadableUrl;
    const isInkwell = comparableOrigin(url) === inkwellOrigin;
    const staticNames = headerNames(transport.httpHeaders);
    const envHeaders = Object.entries(transport.envHttpHeaders ?? {});

    if (transport.name === INKWELL_SERVER_NAME && !isInkwell) {
      refusal ??= CODEX_CONFIG_REFUSALS.inkwellElsewhere;
    }
    if (transport.helper !== null) refusal ??= CODEX_CONFIG_REFUSALS.helper;
    if (staticNames.some((name) => ROUTING_HEADER_NAMES.has(name))) {
      // The actionable one wins: it names the repair.
      return CODEX_CONFIG_REFUSALS.staticRouting;
    }
    if (isInkwell) {
      if (staticNames.includes('authorization')) {
        refusal ??= CODEX_CONFIG_REFUSALS.staticAuthorization;
      }
      // Authorization is owned and never the adapter's, so it always refuses.
      const foreignOwned = envHeaders.some(
        ([header, envVar]) =>
          INKWELL_OWNED_ENV_HEADERS.has(header.toLowerCase()) && !isAdapterEnvHeader(header, envVar)
      );
      if (foreignOwned) refusal ??= CODEX_CONFIG_REFUSALS.inkwellEnvHeader;
    } else {
      const drawn = [transport.bearerTokenEnvVar, ...envHeaders.map(([, envVar]) => envVar)].filter(
        (name): name is string => name !== null
      );
      if (drawn.some((name) => sessionVars.has(name))) {
        refusal ??= CODEX_CONFIG_REFUSALS.foreignSessionEnv;
      }
    }
  }
  return refusal;
}
