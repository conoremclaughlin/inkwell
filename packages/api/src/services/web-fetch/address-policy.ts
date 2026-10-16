/**
 * Which addresses web_fetch may connect to.
 *
 * Ported from OpenClaw (MIT License, Copyright (c) 2025 Peter Steinberger) at
 * commit f88e1f4c1c: the blocked names from src/infra/net/ssrf.ts, and the
 * parsing, special-use ranges and embedded-IPv4 rules of src/shared/net/ip.ts,
 * which ./ip.ts carries on ipaddr.js as OpenClaw does.
 *
 * Three things here are stricter than OpenClaw, and each is checked before
 * OpenClaw's embedded-IPv4 rules can let an address through:
 * - The IPv4-compatible block ::/96 is refused whole, as reserved.
 * - The NAT64 local-use prefix 64:ff9b:1::/48 (RFC 8215) is refused whole. An
 *   operator may translate through any more specific prefix inside it, and
 *   RFC 6052 puts the IPv4 address at a different position for each prefix
 *   length, so no one position can be read and checked. OpenClaw reads the
 *   last 32 bits, and ipaddr.js 2.5 classes the whole /48 as rfc6052, so
 *   64:ff9b:1:1234::a00:1 would be read as public (Lumen, PR #792).
 * - 2001::/23 (IETF protocol assignments) is refused whole, where OpenClaw
 *   lets Teredo and a few other carve-outs through to the embedded-IPv4
 *   check; nothing fetchable lives there, and Teredo's public relays are gone.
 * And the addresses of this machine's own interfaces are refused too,
 * whatever their range: the API and the database listen on every interface
 * of the machine the server runs on, so a public IPv6 address the Mac holds
 * would otherwise reach them.
 *
 * Every refusal names a range, never the address, so a caller can't use the
 * tool to learn what a name resolves to on this side.
 */

import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { networkInterfaces } from 'node:os';
import ipaddr from 'ipaddr.js';
import {
  extractEmbeddedIpv4FromIpv6,
  isBlockedSpecialUseIpv4Address,
  isBlockedSpecialUseIpv6Address,
  isIpv4Address,
  parseCanonicalIpAddress,
} from './ip';

export type RefusedRange =
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'shared'
  | 'unique-local'
  | 'multicast'
  | 'reserved'
  | 'documentation'
  | 'benchmark'
  | 'this-machine'
  | 'unparseable';

const RANGE_PHRASES: Record<RefusedRange, string> = {
  unspecified: 'an unspecified address',
  loopback: 'a loopback address',
  private: 'a private-network address',
  'link-local': 'a link-local address (where cloud metadata services live)',
  shared: 'a shared (carrier-grade NAT) address',
  'unique-local': 'a unique-local IPv6 address',
  multicast: 'a multicast address',
  reserved: 'a reserved address',
  documentation: 'a documentation-only address',
  benchmark: 'a benchmarking address',
  'this-machine': "one of this server's own addresses",
  unparseable: 'an address that could not be parsed',
};

/** "a loopback address", for a refusal message. */
export function describeRange(range: RefusedRange): string {
  return RANGE_PHRASES[range];
}

type Cidr<T> = [T, number];

/**
 * What each refused ipaddr.js range is called in a refusal. Cloud metadata
 * services sit inside these: 169.254.169.254 (AWS, GCP, Azure, Oracle) in
 * link-local, 100.100.100.200 (Alibaba) in shared address space, and
 * 192.0.0.192 (Oracle's older address) in the IETF protocol block.
 */
const IPV4_RANGE_NAMES: Partial<Record<string, RefusedRange>> = {
  unspecified: 'unspecified',
  broadcast: 'reserved',
  multicast: 'multicast',
  linkLocal: 'link-local',
  loopback: 'loopback',
  carrierGradeNat: 'shared',
  private: 'private',
  reserved: 'reserved',
};

/** Parts of ipaddr.js's IPv4 "reserved" that a refusal names more exactly. */
const IPV4_NAMED_PARTS: Array<[Cidr<ipaddr.IPv4>, RefusedRange]> = [
  [ipaddr.IPv4.parseCIDR('192.0.2.0/24'), 'documentation'],
  [ipaddr.IPv4.parseCIDR('198.51.100.0/24'), 'documentation'],
  [ipaddr.IPv4.parseCIDR('203.0.113.0/24'), 'documentation'],
  [ipaddr.IPv4.parseCIDR('198.18.0.0/15'), 'benchmark'],
];

const IPV6_RANGE_NAMES: Partial<Record<string, RefusedRange>> = {
  unspecified: 'unspecified',
  loopback: 'loopback',
  linkLocal: 'link-local',
  uniqueLocal: 'unique-local',
  multicast: 'multicast',
  reserved: 'reserved',
  benchmarking: 'reserved',
  discard: 'reserved',
  orchid2: 'reserved',
  deprecatedSiteLocal: 'private',
};

/** Parts of ipaddr.js's IPv6 "reserved" that are documentation prefixes. */
const IPV6_DOCUMENTATION: Array<Cidr<ipaddr.IPv6>> = [
  ipaddr.IPv6.parseCIDR('2001:db8::/32'),
  ipaddr.IPv6.parseCIDR('3fff::/20'),
];

/** Refused whole, beyond OpenClaw's ranges (see the header). */
const IPV6_REFUSED_WHOLE: Array<Cidr<ipaddr.IPv6>> = [
  ipaddr.IPv6.parseCIDR('::/96'),
  ipaddr.IPv6.parseCIDR('64:ff9b:1::/48'),
  ipaddr.IPv6.parseCIDR('2001::/23'),
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);
const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal'];

/** Lowercase, no trailing dot, no IPv6 brackets. */
export function normalizeHostname(hostname: string): string {
  const lowered = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (lowered.startsWith('[') && lowered.endsWith(']')) return lowered.slice(1, -1);
  return lowered;
}

/** Names refused before any lookup, whatever they would resolve to. */
export function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** The eight 16-bit groups of an IPv6 address, or null for anything else. */
export function ipv6Hextets(address: string): number[] | null {
  const parsed = parseCanonicalIpAddress(address);
  return parsed && !isIpv4Address(parsed) ? [...parsed.parts] : null;
}

/**
 * The IPv4 address an IPv6 one carries, by OpenClaw's rules: IPv4-mapped,
 * IPv4-translated, NAT64, 6to4, Teredo and an ISATAP interface id. The
 * policy refuses the IPv4-compatible block, the local-use NAT64 prefix and
 * Teredo's block whole before it ever reads one (classifyAddress).
 */
export function embeddedIpv4(hextets: number[]): string | null {
  return extractEmbeddedIpv4FromIpv6(new ipaddr.IPv6(hextets))?.toString() ?? null;
}

function classifyIpv4(address: ipaddr.IPv4): RefusedRange | null {
  if (!isBlockedSpecialUseIpv4Address(address)) return null;
  for (const [cidr, range] of IPV4_NAMED_PARTS) {
    if (address.match(cidr)) return range;
  }
  return IPV4_RANGE_NAMES[address.range()] ?? 'reserved';
}

function classifyIpv6(address: ipaddr.IPv6): RefusedRange | null {
  if (isBlockedSpecialUseIpv6Address(address)) {
    if (IPV6_DOCUMENTATION.some((cidr) => address.match(cidr))) return 'documentation';
    return IPV6_RANGE_NAMES[address.range()] ?? 'reserved';
  }
  if (IPV6_REFUSED_WHOLE.some((cidr) => address.match(cidr))) return 'reserved';
  const carried = extractEmbeddedIpv4FromIpv6(address);
  return carried ? classifyIpv4(carried) : null;
}

/**
 * Why an address may not be fetched from, or null when it may. Anything that
 * doesn't parse as an IP address is refused, an IPv4 address not written as
 * four decimal parts (`127.1`, `0x7f.0.0.1`) among it.
 */
export function classifyAddress(address: string): RefusedRange | null {
  const bare = normalizeHostname(address).replace(/%.*$/, '');
  const parsed = parseCanonicalIpAddress(bare);
  if (!parsed) return 'unparseable';
  return isIpv4Address(parsed) ? classifyIpv4(parsed) : classifyIpv6(parsed);
}

/**
 * This machine's own interface addresses. Read on every call rather than
 * cached, because interfaces come and go (a VPN, a new network); the read is
 * a getifaddrs call, with no I/O to wait on.
 */
function isThisMachine(address: string): boolean {
  const bare = normalizeHostname(address).replace(/%.*$/, '');
  const family = isIPv4(bare) ? 'ipv4' : isIPv6(bare) ? 'ipv6' : null;
  if (!family) return false;
  const own = new BlockList();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const local = entry.address.replace(/%.*$/, '');
      if (isIPv4(local)) own.addAddress(local, 'ipv4');
      else if (isIPv6(local)) own.addAddress(local, 'ipv6');
    }
  }
  return own.check(bare, family);
}

/** The policy web_fetch runs under: every special-use range, and this machine. */
export function refusalFor(address: string): RefusedRange | null {
  return classifyAddress(address) ?? (isThisMachine(address) ? 'this-machine' : null);
}
