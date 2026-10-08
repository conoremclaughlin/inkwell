/**
 * Which addresses web_fetch may connect to.
 *
 * Ported from OpenClaw (MIT License, Copyright (c) 2025 Peter Steinberger),
 * src/infra/net/ssrf.ts and src/shared/net/ip.ts at f88e1f4c1c: the blocked
 * names, the special-use ranges, and the rules that find an IPv4 address
 * carried inside an IPv6 one. Two things differ. Range membership is tested
 * with Node's own net.BlockList rather than ipaddr.js, so the port adds no
 * dependency. And the addresses of this machine's own interfaces are refused
 * too, whatever their range: the API and the database listen on every
 * interface of the machine the server runs on, so a public IPv6 address the
 * Mac holds would otherwise reach them.
 *
 * Every refusal names a range, never the address, so a caller can't use the
 * tool to learn what a name resolves to on this side.
 */

import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { networkInterfaces } from 'node:os';

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

type RangeList = Array<{ list: BlockList; range: RefusedRange }>;

function rangeList(
  family: 'ipv4' | 'ipv6',
  entries: Array<[network: string, prefix: number, range: RefusedRange]>
): RangeList {
  return entries.map(([network, prefix, range]) => {
    const list = new BlockList();
    list.addSubnet(network, prefix, family);
    return { list, range };
  });
}

/**
 * ipaddr.js's IPv4 special ranges, as OpenClaw blocks them. Cloud metadata
 * services sit inside these: 169.254.169.254 (AWS, GCP, Azure, Oracle) in
 * link-local, 100.100.100.200 (Alibaba) in shared address space, and
 * 192.0.0.192 (Oracle's older address) in the IETF protocol block.
 */
const IPV4_RANGES = rangeList('ipv4', [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'shared'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmark'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
]);

/**
 * IPv6 special ranges. Order matters for the label only: the first match
 * names the refusal. 2001::/23 (IETF protocol assignments) is refused whole,
 * where OpenClaw lets Teredo and a few other carve-outs through to the
 * embedded-IPv4 check; nothing fetchable lives there, and Teredo's public
 * relays are gone. AWS's IPv6 metadata address, fd00:ec2::254, is unique-local.
 *
 * The NAT64 local-use prefix, 64:ff9b:1::/48 (RFC 8215), is refused whole as
 * well. An operator may translate through any more specific prefix inside
 * it, and RFC 6052 puts the IPv4 address at a different position for each
 * prefix length, so no one position can be read and checked. OpenClaw read
 * the last 32 bits of 64:ff9b:1::/96 only, which let 64:ff9b:1:1234::a00:1
 * through (Lumen, PR #792).
 */
const IPV6_RANGES = rangeList('ipv6', [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['::', 96, 'reserved'],
  ['64:ff9b:1::', 48, 'reserved'],
  ['100::', 64, 'reserved'],
  ['2001::', 23, 'reserved'],
  ['2001:db8::', 32, 'documentation'],
  ['fc00::', 7, 'unique-local'],
  ['fec0::', 10, 'private'],
  ['fe80::', 10, 'link-local'],
  ['ff00::', 8, 'multicast'],
]);

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

/**
 * The eight 16-bit groups of an IPv6 address, or null. Expects an address
 * `isIPv6` accepts, without a zone; handles `::` and a trailing dotted quad.
 */
export function ipv6Hextets(address: string): number[] | null {
  if (!isIPv6(address)) return null;
  let text = address;
  const trailing: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return null;
    const octets = tail.split('.').map(Number);
    trailing.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    text = text.slice(0, lastColon + 1);
    // "::ffff:" keeps its group, "::" stays the compression.
    if (!text.endsWith('::')) text = text.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === '' ? [] : part.split(':').map((h) => parseInt(h, 16)));
  const left = groups(halves[0]);
  const right = halves.length === 2 ? groups(halves[1]) : [];
  const wanted = 8 - trailing.length;
  const fill = halves.length === 2 ? wanted - left.length - right.length : 0;
  if (fill < 0 || (halves.length === 1 && left.length !== wanted)) return null;
  const hextets = [...left, ...new Array<number>(fill).fill(0), ...right, ...trailing];
  if (hextets.length !== 8 || hextets.some((h) => !Number.isInteger(h) || h < 0 || h > 0xffff)) {
    return null;
  }
  return hextets;
}

function ipv4FromHextets(high: number, low: number): string {
  return [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff].join('.');
}

/**
 * The IPv4 address an IPv6 one carries, when it is one of the forms that
 * route to it: IPv4-mapped (::ffff:0:0/96), IPv4-translated (::ffff:0:0:0/96),
 * well-known NAT64 (64:ff9b::/96), 6to4 (2002::/16), and an ISATAP interface
 * id (…:0:5efe:w.x.y.z). OpenClaw's rules, ported; the local-use NAT64 prefix
 * is a refused range instead (see IPV6_RANGES).
 */
export function embeddedIpv4(hextets: number[]): string | null {
  const [a, b, c, d, e, f, g, h] = hextets;
  const zero = (...values: number[]) => values.every((value) => value === 0);
  if (zero(a, b, c, d, e) && f === 0xffff) return ipv4FromHextets(g, h);
  if (zero(a, b, c, d) && e === 0xffff && f === 0) return ipv4FromHextets(g, h);
  if (a === 0x0064 && b === 0xff9b && zero(c, d, e, f)) return ipv4FromHextets(g, h);
  if (a === 0x2002) return ipv4FromHextets(b, c);
  if ((e & 0xfcff) === 0 && f === 0x5efe) return ipv4FromHextets(g, h);
  return null;
}

function classifyIpv4(address: string): RefusedRange | null {
  for (const { list, range } of IPV4_RANGES) {
    if (list.check(address, 'ipv4')) return range;
  }
  return null;
}

/**
 * Why an address may not be fetched from, or null when it may. Anything that
 * doesn't parse as an IP address is refused.
 */
export function classifyAddress(address: string): RefusedRange | null {
  const bare = normalizeHostname(address).replace(/%.*$/, '');
  if (isIPv4(bare)) return classifyIpv4(bare);
  const hextets = ipv6Hextets(bare);
  if (!hextets) return 'unparseable';
  for (const { list, range } of IPV6_RANGES) {
    if (list.check(bare, 'ipv6')) return range;
  }
  const carried = embeddedIpv4(hextets);
  return carried ? classifyIpv4(carried) : null;
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
