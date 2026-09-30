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
 * - a session routing header drawn from the env for a server that is not
 *   Inkwell: the session's routing sent to someone else;
 * - a static Authorization for the Inkwell server: a fixed identity in place
 *   of the session's own token;
 * - any header helper: its output is invisible to `mcp list`, so nothing it
 *   sends can be checked;
 * - a server named `inkwell` that is not at the Inkwell server this session
 *   was given: the adapter's own `-c` overrides attach the session's token
 *   and routing to whatever server carries that name.
 *
 * The listing prints static header VALUES in the clear (Myra, 7ca2a2d1), so
 * only key names are read. Every refusal is a fixed string, and nothing from
 * the listing, including a parse error that could quote it, reaches a reason.
 *
 * The shape is pinned to what codex-cli 0.158.0 printed. Anything else is
 * refused as drift rather than guessed at.
 */

export const CODEX_MCP_LIST_MEASURED_AGAINST = 'codex-cli 0.158.0';

export const CODEX_CONFIG_REFUSALS = {
  drift: `\`codex mcp list --json\` did not have the shape measured against ${CODEX_MCP_LIST_MEASURED_AGAINST}; Codex was not started, because its MCP configuration could not be checked`,
  staticRouting:
    'a session routing header is configured in the Codex config; run `ink mcp sync` in this studio',
  foreignRouting:
    'a session routing header is configured for an MCP server other than Inkwell in the Codex config',
  staticAuthorization:
    'a static Authorization header is configured for the Inkwell MCP server in the Codex config',
  helper:
    'an MCP server in the Codex config computes its headers with http_headers_helper, which cannot be checked',
  inkwellElsewhere:
    "the Codex config's `inkwell` MCP server is not this session's Inkwell server; run `ink mcp sync` in this studio",
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

type HeaderMap = Record<string, unknown> | null;

/** The server name the Codex adapter's `-c` overrides write to. */
const INKWELL_SERVER_NAME = 'inkwell';

interface HttpTransport {
  name: string;
  url: string;
  httpHeaders: HeaderMap;
  envHttpHeaders: HeaderMap;
  helper: string | null;
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
    !isHeaderMap(env_http_headers) ||
    !isNullableString(http_headers_helper)
  ) {
    return undefined;
  }
  return {
    name,
    url,
    httpHeaders: http_headers,
    envHttpHeaders: env_http_headers,
    helper: http_headers_helper,
  };
}

function headerNames(map: HeaderMap): string[] {
  return map ? Object.keys(map).map((name) => name.toLowerCase()) : [];
}

/**
 * Loopback hosts, which all reach this machine: `localhost` and its
 * subdomains, 127.0.0.0/8, `::1` (bare or IPv4-mapped) and `0.0.0.0`, which
 * a client connecting to it lands on the local server with.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127(\.\d{1,3}){3}$/.test(host) ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^::ffff:(127(\.\d{1,3}){3}|7f[0-9a-f]{2}:[0-9a-f]{1,4})$/.test(host)
  );
}

/**
 * An origin with every loopback alias folded into one host. URL parsing has
 * already lower-cased the host, canonicalised IPv4 spellings and dropped a
 * default port written out.
 */
function comparableOrigin(url: URL): string {
  const host = isLoopbackHost(url.hostname) ? 'loopback' : url.hostname;
  return `${url.protocol}//${host}:${url.port}`;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Judge the stdout of `codex mcp list --json`. Returns the fixed reason to
 * refuse the spawn, or undefined when the effective config is safe to run.
 *
 * `inkwellMcpUrl` is the Inkwell server this session was given by its host,
 * never read from the config under check: a config pointing its `inkwell`
 * entry elsewhere must not move what counts as Inkwell.
 */
export function judgeCodexMcpList(
  stdout: string,
  inkwellMcpUrl: string
): CodexConfigRefusal | undefined {
  const inkwell = parseUrl(inkwellMcpUrl);
  if (!inkwell) return CODEX_CONFIG_REFUSALS.unreadableInkwellUrl;
  const inkwellOrigin = comparableOrigin(inkwell);

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
      if (server.name === INKWELL_SERVER_NAME) refusal ??= CODEX_CONFIG_REFUSALS.inkwellElsewhere;
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
    const envNames = headerNames(transport.envHttpHeaders);

    if (transport.name === INKWELL_SERVER_NAME && !isInkwell) {
      refusal ??= CODEX_CONFIG_REFUSALS.inkwellElsewhere;
    }
    if (transport.helper !== null) refusal ??= CODEX_CONFIG_REFUSALS.helper;
    if (staticNames.some((name) => ROUTING_HEADER_NAMES.has(name))) {
      // The actionable one wins: it names the repair.
      return CODEX_CONFIG_REFUSALS.staticRouting;
    }
    if (!isInkwell && envNames.some((name) => ROUTING_HEADER_NAMES.has(name))) {
      refusal ??= CODEX_CONFIG_REFUSALS.foreignRouting;
    }
    if (isInkwell && staticNames.includes('authorization')) {
      refusal ??= CODEX_CONFIG_REFUSALS.staticAuthorization;
    }
  }
  return refusal;
}
