/**
 * IP address parsing and special-use classification, on ipaddr.js.
 *
 * Ported from OpenClaw (MIT License, Copyright (c) 2025 Peter Steinberger),
 * src/shared/net/ip.ts at commit f88e1f4c1c. What's here is that file's code
 * for parsing an address and deciding whether it's special-use, kept as close
 * to the original as this codebase's style allows. Its other helpers (loose
 * parsing, CIDR matching, the loopback and RFC 1918 predicates) aren't used
 * by web_fetch and were left out, as were the two exemption options
 * (`allowRfc2544BenchmarkRange`, `allowUniqueLocalRange`) that let an
 * operator's fake-ip proxy through: web_fetch never exempts a range.
 * `normalizeOptionalString` from OpenClaw's string-coerce is a local
 * one-liner here. One change in behaviour: an IPv6 address written with a
 * dotted quad is parsed by the converter alone (parseCanonicalIpAddress
 * says why).
 *
 * The policy built on this, with the ranges we refuse beyond OpenClaw's, is
 * address-policy.ts.
 */

import ipaddr from 'ipaddr.js';

export type ParsedIpAddress = ipaddr.IPv4 | ipaddr.IPv6;
type Ipv4Range = ReturnType<ipaddr.IPv4['range']>;
type Ipv6Range = ReturnType<ipaddr.IPv6['range']>;
type BlockedIpv6Range = Ipv6Range | 'discard';

const BLOCKED_IPV4_SPECIAL_USE_RANGES = new Set<Ipv4Range>([
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'loopback',
  'carrierGradeNat',
  'private',
  'reserved',
]);

const BLOCKED_IPV6_SPECIAL_USE_RANGES = new Set<BlockedIpv6Range>([
  'unspecified',
  'loopback',
  'linkLocal',
  'uniqueLocal',
  'multicast',
  'reserved',
  'benchmarking',
  'discard',
  'orchid2',
]);
const RFC2544_BENCHMARK_PREFIX: [ipaddr.IPv4, number] = [ipaddr.IPv4.parse('198.18.0.0'), 15];

const EMBEDDED_IPV4_SENTINEL_RULES: Array<{
  matches: (parts: number[]) => boolean;
  toHextets: (parts: number[]) => [high: number, low: number];
}> = [
  {
    // IPv4-compatible form ::w.x.y.z (deprecated, but still seen in parser edge-cases).
    matches: (parts) =>
      parts[0] === 0 &&
      parts[1] === 0 &&
      parts[2] === 0 &&
      parts[3] === 0 &&
      parts[4] === 0 &&
      parts[5] === 0,
    toHextets: (parts) => [parts[6], parts[7]],
  },
  {
    // NAT64 local-use prefix: 64:ff9b:1::/48.
    matches: (parts) =>
      parts[0] === 0x0064 &&
      parts[1] === 0xff9b &&
      parts[2] === 0x0001 &&
      parts[3] === 0 &&
      parts[4] === 0 &&
      parts[5] === 0,
    toHextets: (parts) => [parts[6], parts[7]],
  },
  {
    // 6to4 prefix: 2002::/16 (IPv4 lives in hextets 1..2).
    matches: (parts) => parts[0] === 0x2002,
    toHextets: (parts) => [parts[1], parts[2]],
  },
  {
    // Teredo prefix: 2001:0000::/32 (client IPv4 XOR 0xffff in hextets 6..7).
    matches: (parts) => parts[0] === 0x2001 && parts[1] === 0x0000,
    toHextets: (parts) => [parts[6] ^ 0xffff, parts[7] ^ 0xffff],
  },
  {
    // ISATAP IID marker: ....:0000:5efe:w.x.y.z with u/g bits allowed in hextet 4.
    matches: (parts) => (parts[4] & 0xfcff) === 0 && parts[5] === 0x5efe,
    toHextets: (parts) => [parts[6], parts[7]],
  },
];

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stripIpv6Brackets(value: string): string {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1);
  }
  return value;
}

function parseIpv6WithEmbeddedIpv4(raw: string): ipaddr.IPv6 | undefined {
  if (!raw.includes(':') || !raw.includes('.')) {
    return undefined;
  }
  const match = /^(.*:)([^:%]+(?:\.[^:%]+){3})(%[0-9A-Za-z]+)?$/i.exec(raw);
  if (!match) {
    return undefined;
  }
  const [, prefix, embeddedIpv4, zoneSuffix = ''] = match;
  if (!ipaddr.IPv4.isValidFourPartDecimal(embeddedIpv4)) {
    return undefined;
  }
  const octets = embeddedIpv4.split('.').map((part) => Number.parseInt(part, 10));
  const high = ((octets[0] << 8) | octets[1]).toString(16);
  const low = ((octets[2] << 8) | octets[3]).toString(16);
  const normalizedIpv6 = `${prefix}${high}:${low}${zoneSuffix}`;
  if (!ipaddr.IPv6.isValid(normalizedIpv6)) {
    return undefined;
  }
  return ipaddr.IPv6.parse(normalizedIpv6);
}

export function isIpv4Address(address: ParsedIpAddress): address is ipaddr.IPv4 {
  return address.kind() === 'ipv4';
}

export function isIpv6Address(address: ParsedIpAddress): address is ipaddr.IPv6 {
  return address.kind() === 'ipv6';
}

function normalizeIpParseInput(raw: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return undefined;
  }
  return stripIpv6Brackets(trimmed);
}

/**
 * An IPv4 address only in canonical four-part decimal (so `127.1` and
 * `0x7f.0.0.1` don't parse), or an IPv6 address, with or without brackets.
 */
export function parseCanonicalIpAddress(raw: string | undefined): ParsedIpAddress | undefined {
  const normalized = normalizeIpParseInput(raw);
  if (!normalized) {
    return undefined;
  }
  if (ipaddr.IPv4.isValid(normalized)) {
    if (!ipaddr.IPv4.isValidFourPartDecimal(normalized)) {
      return undefined;
    }
    return ipaddr.IPv4.parse(normalized);
  }
  // Not OpenClaw's order. ipaddr.js 2.5 reads every `::a.b.c.d` as the
  // IPv4-mapped `::ffff:a.b.c.d`, so `::8.8.8.8` (IPv4-compatible, inside
  // ::/96) came back as mapped 8.8.8.8 and passed a ::/96 refusal. An IPv6
  // address with a dotted quad is read only by the converter, which turns
  // the quad into two hextets where it stands.
  if (normalized.includes(':') && normalized.includes('.')) {
    return parseIpv6WithEmbeddedIpv4(normalized);
  }
  if (ipaddr.IPv6.isValid(normalized)) {
    return ipaddr.IPv6.parse(normalized);
  }
  return undefined;
}

export function isBlockedSpecialUseIpv6Address(address: ipaddr.IPv6): boolean {
  // ipaddr.js returns "discard" at runtime for 100::/64, but its published
  // TypeScript IPv6Range union omits that literal.
  const range = address.range() as BlockedIpv6Range;
  if (BLOCKED_IPV6_SPECIAL_USE_RANGES.has(range)) {
    return true;
  }
  // ipaddr.js does not classify deprecated site-local fec0::/10 as private.
  return (address.parts[0] & 0xffc0) === 0xfec0;
}

export function isBlockedSpecialUseIpv4Address(address: ipaddr.IPv4): boolean {
  const inRfc2544BenchmarkRange = address.match(RFC2544_BENCHMARK_PREFIX);
  return BLOCKED_IPV4_SPECIAL_USE_RANGES.has(address.range()) || inRfc2544BenchmarkRange;
}

function decodeIpv4FromHextets(high: number, low: number): ipaddr.IPv4 {
  const octets: [number, number, number, number] = [
    (high >>> 8) & 0xff,
    high & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  ];
  return ipaddr.IPv4.parse(octets.join('.'));
}

export function extractEmbeddedIpv4FromIpv6(address: ipaddr.IPv6): ipaddr.IPv4 | undefined {
  if (address.isIPv4MappedAddress()) {
    return address.toIPv4Address();
  }
  if (address.range() === 'rfc6145') {
    return decodeIpv4FromHextets(address.parts[6], address.parts[7]);
  }
  if (address.range() === 'rfc6052') {
    return decodeIpv4FromHextets(address.parts[6], address.parts[7]);
  }
  for (const rule of EMBEDDED_IPV4_SENTINEL_RULES) {
    if (!rule.matches(address.parts)) {
      continue;
    }
    const [high, low] = rule.toHextets(address.parts);
    return decodeIpv4FromHextets(high, low);
  }
  return undefined;
}
