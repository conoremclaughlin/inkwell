/**
 * A GET that only ever connects to an address it has checked.
 *
 * Ported from OpenClaw (MIT License, Copyright (c) 2025 Peter Steinberger),
 * src/infra/net/fetch-guard.ts and the pinned lookup in src/infra/net/ssrf.ts
 * at f88e1f4c1c: resolve the name once, refuse if any answer is in a blocked
 * range, connect through a lookup that can only return those answers, and
 * follow redirects by hand with the same check on every hop. OpenClaw does
 * this through undici; this port uses node:http and node:https, which need no
 * dependency, and drops the proxy modes, which have no use here.
 *
 * What each hop is held to:
 * - http or https, and no user:password in the URL.
 * - The name isn't one refused outright (localhost, *.local, *.internal, …).
 * - Every address the name resolves to passes the address policy. One bad
 *   answer refuses the hop: a name that resolves to a public address and to
 *   127.0.0.1 is not partly fetchable.
 * - The connection goes through a fresh Agent whose lookup returns only the
 *   addresses that passed, so a DNS answer that changes between the check and
 *   the connect (a rebind) is never consulted. An IP literal is the address
 *   it names, checked the same way. The Agent is never the global one: under
 *   NODE_USE_ENV_PROXY, Node 22's global agent sends requests to an
 *   environment proxy, which would resolve the name itself (measured on
 *   v22.21.0: globalAgent.options.proxyEnv is set, a new Agent's is not).
 * - No cookies, no Authorization, nothing but the fixed headers below. A
 *   Set-Cookie on a redirect is never sent back.
 *
 * And the whole fetch, every hop included, has one deadline and one cap on
 * the bytes read after decompression.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction, Socket } from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import {
  describeRange,
  isBlockedHostname,
  normalizeHostname,
  refusalFor,
  type RefusedRange,
} from './address-policy';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** What the guard uses to reach the network. Production passes nothing. */
export interface GuardNetwork {
  /** Resolve a name to every address it has. Default: dns.promises.lookup. */
  resolve: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Why an address is refused, or null. Default: the address policy. */
  refusalFor: (address: string) => RefusedRange | null;
}

export interface GuardLimits {
  /** Redirects followed before giving up. */
  maxRedirects: number;
  /** Body bytes kept, after decompression. Reading stops there. */
  maxBodyBytes: number;
  /** One deadline for the whole fetch: every lookup, hop and byte. */
  timeoutMs: number;
}

export const DEFAULT_GUARD_LIMITS: GuardLimits = {
  maxRedirects: 5,
  maxBodyBytes: 2_000_000,
  timeoutMs: 30_000,
};

export interface GuardedResponse {
  /** The URL that answered, after redirects. */
  finalUrl: string;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The body was longer than maxBodyBytes and was cut there. */
  bodyTruncated: boolean;
  redirects: number;
}

/**
 * Why a fetch failed, in a fixed vocabulary. The audit log records this and
 * never an exception's text, which can carry a URL and its query (Lumen,
 * PR #792).
 */
export type WebFetchFailureReason =
  | 'invalid-url'
  | 'scheme'
  | 'credentials'
  | 'no-host'
  | 'blocked-name'
  | 'blocked-address'
  | 'no-address'
  | 'timeout'
  | 'redirect-without-location'
  | 'redirect-invalid'
  | 'redirect-limit'
  | 'redirect-loop'
  | 'protocol-switch'
  | 'unsupported-encoding'
  | 'unreadable-body'
  | 'network';

/** A fetch that failed. The message is for the caller; `reason` is for the record. */
export class WebFetchError extends Error {
  /** The last URL the fetch reached, when it got as far as a hop. */
  hopUrl?: string;

  constructor(
    message: string,
    readonly reason: WebFetchFailureReason,
    /** A Node error code (ECONNREFUSED, CERT_HAS_EXPIRED…), for `network`. */
    readonly code?: string
  ) {
    super(message);
    this.name = 'WebFetchError';
  }
}

/** The fetch was refused before it connected anywhere it shouldn't. */
export class WebFetchRefusal extends WebFetchError {
  constructor(
    message: string,
    reason: WebFetchFailureReason,
    readonly range?: RefusedRange
  ) {
    super(message, reason);
    this.name = 'WebFetchRefusal';
  }
}

/** Any failure as a WebFetchError, a foreign one (a socket's, a resolver's) as `network`. */
function asWebFetchError(error: unknown, hop: URL | undefined): WebFetchError {
  const failure =
    error instanceof WebFetchError
      ? error
      : new WebFetchError(
          error instanceof Error ? error.message : String(error),
          'network',
          typeof (error as NodeJS.ErrnoException)?.code === 'string'
            ? (error as NodeJS.ErrnoException).code
            : undefined
        );
  if (hop && !failure.hopUrl) failure.hopUrl = hop.toString();
  return failure;
}

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; InkwellWebFetch/1.0)',
  Accept: 'text/markdown, text/html;q=0.9, */*;q=0.1',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  const answers = await dnsLookup(hostname, { all: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4,
  }));
}

const DEFAULT_NETWORK: GuardNetwork = { resolve: systemResolve, refusalFor };

/** IPv4 first, as OpenClaw orders them, duplicates dropped. */
function preferIpv4(addresses: ResolvedAddress[]): ResolvedAddress[] {
  const seen = new Set<string>();
  const unique = addresses.filter(({ address }) => !seen.has(address) && !!seen.add(address));
  return [...unique.filter((a) => a.family === 4), ...unique.filter((a) => a.family === 6)];
}

/**
 * A lookup that answers only for `hostname`, and only with `pinned`. Node
 * calls it with `{ all: true }` when it races address families, and without
 * for a single address; both are served from the same checked list.
 */
function pinnedLookup(hostname: string, pinned: ResolvedAddress[]): LookupFunction {
  let next = 0;
  return ((host: string, options: unknown, callback: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | ResolvedAddress[],
      family?: number
    ) => void;
    const opts = (typeof options === 'object' && options !== null ? options : {}) as {
      all?: boolean;
      family?: number | string;
    };
    if (normalizeHostname(host) !== hostname) {
      cb(new Error(`web_fetch: no pinned address for ${host}`), '');
      return;
    }
    const family = opts.family === 6 || opts.family === 'IPv6' ? 6 : opts.family === 4 ? 4 : 0;
    const matching = family ? pinned.filter((entry) => entry.family === family) : pinned;
    const usable = matching.length > 0 ? matching : pinned;
    if (opts.all) {
      cb(null, usable);
      return;
    }
    const chosen = usable[next++ % usable.length];
    cb(null, chosen.address, chosen.family);
  }) as LookupFunction;
}

function refuse(message: string, reason: WebFetchFailureReason, range?: RefusedRange): never {
  throw new WebFetchRefusal(message, reason, range);
}

function parseHop(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    refuse('Not a valid URL.', 'invalid-url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    refuse(`Only http and https URLs can be fetched, not ${url.protocol}`, 'scheme');
  }
  if (url.username || url.password) {
    refuse('URLs carrying a username or password are not fetched.', 'credentials');
  }
  return url;
}

/**
 * `work`, or the deadline if it comes first. When the deadline wins, `work`
 * still has its rejection handled here, so a failure it reaches later is
 * never an unhandled rejection (which would end the process).
 */
function untilDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/** Resolve and check one hop's host. Throws WebFetchRefusal when refused. */
export async function checkedAddresses(
  hostname: string,
  network: GuardNetwork
): Promise<ResolvedAddress[]> {
  const host = normalizeHostname(hostname);
  if (!host) refuse('The URL has no host.', 'no-host');
  const literal = isIP(host);
  if (!literal && isBlockedHostname(host)) {
    refuse(`${host} is a local or internal name and is not fetched.`, 'blocked-name');
  }
  const answers: ResolvedAddress[] = literal
    ? [{ address: host, family: literal === 6 ? 6 : 4 }]
    : await network.resolve(host);
  if (answers.length === 0) {
    throw new WebFetchError(`${host} did not resolve to any address.`, 'no-address');
  }
  for (const { address } of answers) {
    const range = network.refusalFor(address);
    if (range) {
      const verb = literal ? 'is' : 'resolves to';
      refuse(
        `${host} ${verb} ${describeRange(range)} and is not fetched.`,
        'blocked-address',
        range
      );
    }
  }
  return preferIpv4(answers);
}

function requestOnce(
  url: URL,
  pinned: ResolvedAddress[],
  signal: AbortSignal
): Promise<{ response: IncomingMessage; agent: http.Agent }> {
  const host = normalizeHostname(url.hostname);
  const secure = url.protocol === 'https:';
  const agentOptions = { keepAlive: false, maxSockets: 1, lookup: pinnedLookup(host, pinned) };
  const agent = secure ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
  const transport = secure ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: REQUEST_HEADERS,
        agent,
        signal,
      },
      (response) => resolve({ response, agent })
    );
    request.on('error', (error) => {
      agent.destroy();
      reject(error);
    });
    // A 101 never reaches the response callback: Node hands the socket to
    // 'upgrade' listeners, and with none the request just waits (Lumen, PR
    // #792). There is nothing to read from a switched protocol.
    request.on('upgrade', (response: IncomingMessage, socket: Socket) => {
      socket.destroy();
      response.destroy();
      agent.destroy();
      reject(
        new WebFetchError(
          `The server answered ${response.statusCode} Switching Protocols, which web_fetch does not follow.`,
          'protocol-switch'
        )
      );
    });
    request.end();
  });
}

function decoded(response: IncomingMessage): Readable {
  const encoding = String(response.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase();
  let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress;
  if (encoding === '' || encoding === 'identity') return response;
  if (encoding === 'gzip' || encoding === 'x-gzip') decoder = zlib.createGunzip();
  else if (encoding === 'deflate') decoder = zlib.createInflate();
  else if (encoding === 'br') decoder = zlib.createBrotliDecompress();
  else {
    throw new WebFetchError(
      `The response used an unsupported content-encoding: ${encoding.slice(0, 40)}`,
      'unsupported-encoding'
    );
  }
  response.on('error', (error) => decoder.destroy(error));
  return response.pipe(decoder);
}

async function readCapped(
  response: IncomingMessage,
  maxBytes: number
): Promise<{ body: Buffer; truncated: boolean }> {
  let stream: Readable = response;
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    stream = decoded(response);
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      const room = maxBytes - total;
      if (buffer.length >= room) {
        chunks.push(buffer.subarray(0, room));
        total += room;
        // Equal to the cap is only truncated if anything follows; one more
        // byte is never read to find out, so say it was.
        truncated = true;
        break;
      }
      chunks.push(buffer);
      total += buffer.length;
    }
  } finally {
    stream.destroy();
    response.destroy();
  }
  return { body: Buffer.concat(chunks, total), truncated };
}

/**
 * GET `rawUrl` under the guard. Every failure throws a WebFetchError with a
 * fixed `reason` and the last hop it reached; a refusal is a WebFetchRefusal.
 * Any status that isn't a followed redirect is returned, 4xx and 5xx included.
 */
export async function guardedGet(
  rawUrl: string,
  options: { limits?: Partial<GuardLimits>; network?: Partial<GuardNetwork> } = {}
): Promise<GuardedResponse> {
  const limits = { ...DEFAULT_GUARD_LIMITS, ...options.limits };
  const network = { ...DEFAULT_NETWORK, ...options.network };
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new WebFetchError(`web_fetch timed out after ${limits.timeoutMs}ms`, 'timeout')
      ),
    limits.timeoutMs
  );
  const { signal } = controller;
  const progress: { hop?: URL } = {};
  try {
    // The deadline is raced here, around everything, so no state a hop gets
    // stuck in (a lookup that never answers, a protocol switch) outlives it.
    return await untilDeadline(followHops(rawUrl, limits, network, signal, progress), signal);
  } catch (error) {
    throw asWebFetchError(error, progress.hop);
  } finally {
    clearTimeout(timer);
  }
}

async function followHops(
  rawUrl: string,
  limits: GuardLimits,
  network: GuardNetwork,
  signal: AbortSignal,
  progress: { hop?: URL }
): Promise<GuardedResponse> {
  let current = parseHop(rawUrl);
  const visited = new Set([current.toString()]);
  let redirects = 0;
  try {
    for (;;) {
      progress.hop = current;
      const pinned = await checkedAddresses(current.hostname, network);
      // A lookup that answers after the deadline must not start a connection.
      signal.throwIfAborted();
      const { response, agent } = await requestOnce(current, pinned, signal);
      try {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (REDIRECT_STATUSES.has(status)) {
          response.destroy();
          if (!location) {
            throw new WebFetchError(
              `Redirect (${status}) without a Location header.`,
              'redirect-without-location'
            );
          }
          redirects += 1;
          if (redirects > limits.maxRedirects) {
            throw new WebFetchError(
              `Too many redirects (limit ${limits.maxRedirects}).`,
              'redirect-limit'
            );
          }
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            throw new WebFetchError(`Redirect (${status}) to an invalid URL.`, 'redirect-invalid');
          }
          next = parseHop(next.toString());
          if (visited.has(next.toString())) {
            throw new WebFetchError('Redirect loop.', 'redirect-loop');
          }
          visited.add(next.toString());
          current = next;
          continue;
        }
        const { body, truncated } = await readCapped(response, limits.maxBodyBytes);
        return {
          finalUrl: current.toString(),
          status,
          headers: response.headers,
          body,
          bodyTruncated: truncated,
          redirects,
        };
      } finally {
        agent.destroy();
      }
    }
  } catch (error) {
    // An abort surfaces as the stream's AbortError; report the deadline.
    const failure = signal.aborted && !(error instanceof WebFetchRefusal) ? signal.reason : error;
    throw asWebFetchError(failure, current);
  }
}
