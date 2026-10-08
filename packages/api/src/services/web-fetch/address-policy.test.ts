/**
 * The address policy as a pure function. Nothing here touches the network:
 * the flow-level refusals, against local servers, are in guarded-get.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';

const fakeInterfaces = vi.hoisted(() => ({
  value: {} as Record<string, Array<{ address: string }>>,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, networkInterfaces: () => fakeInterfaces.value };
});

import {
  classifyAddress,
  embeddedIpv4,
  ipv6Hextets,
  isBlockedHostname,
  refusalFor,
} from './address-policy';

describe('classifyAddress', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.86.60', 'private'],
    ['169.254.169.254', 'link-local'],
    ['169.254.0.1', 'link-local'],
    ['100.64.0.1', 'shared'],
    ['100.100.100.200', 'shared'],
    ['192.0.0.192', 'reserved'],
    ['192.0.2.10', 'documentation'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['198.18.0.1', 'benchmark'],
    ['198.19.255.255', 'benchmark'],
    ['224.0.0.251', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
  ])('refuses IPv4 %s as %s', (address, range) => {
    expect(classifyAddress(address)).toBe(range);
  });

  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::7f00:1', 'reserved'],
    ['100::1', 'reserved'],
    ['2001::1', 'reserved'],
    ['2001:2::1', 'reserved'],
    ['2001:db8::1', 'documentation'],
    ['fd00:ec2::254', 'unique-local'],
    ['fc00::1', 'unique-local'],
    ['fec0::1', 'private'],
    ['fe80::1', 'link-local'],
    ['fe80::1%en0', 'link-local'],
    ['ff02::1', 'multicast'],
  ])('refuses IPv6 %s as %s', (address, range) => {
    expect(classifyAddress(address)).toBe(range);
  });

  it.each([
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:a9fe:a9fe', 'link-local'],
    ['::ffff:0:a00:1', 'private'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::a9fe:a9fe', 'link-local'],
    ['64:ff9b:1::a00:1', 'private'],
    ['2002:7f00:1::', 'loopback'],
    ['2002:c0a8:0101::1', 'private'],
    ['2600:1f18::5efe:7f00:1', 'loopback'],
    ['2600:1f18::200:5efe:a9fe:a9fe', 'link-local'],
  ])('refuses %s by the IPv4 address it carries (%s)', (address, range) => {
    expect(classifyAddress(address)).toBe(range);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.215.14',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::1',
  ])('lets public %s through', (address) => {
    expect(classifyAddress(address)).toBeNull();
  });

  it.each(['example.com', '127.1', '0x7f.0.0.1', '1.2.3', '', 'not an address', '::g'])(
    'refuses %j, which is not an IP address',
    (value) => {
      expect(classifyAddress(value)).toBe('unparseable');
    }
  );
});

describe('ipv6Hextets', () => {
  it.each([
    ['::', [0, 0, 0, 0, 0, 0, 0, 0]],
    ['::1', [0, 0, 0, 0, 0, 0, 0, 1]],
    ['1::', [1, 0, 0, 0, 0, 0, 0, 0]],
    ['2001:db8::8:800:200c:417a', [0x2001, 0xdb8, 0, 0, 0x8, 0x800, 0x200c, 0x417a]],
    ['::ffff:127.0.0.1', [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]],
    ['::127.0.0.1', [0, 0, 0, 0, 0, 0, 0x7f00, 1]],
    ['1:2:3:4:5:6:1.2.3.4', [1, 2, 3, 4, 5, 6, 0x102, 0x304]],
    ['1:2:3:4:5:6:7:8', [1, 2, 3, 4, 5, 6, 7, 8]],
    ['fe80::1:2', [0xfe80, 0, 0, 0, 0, 0, 1, 2]],
  ])('reads %s', (address, hextets) => {
    expect(ipv6Hextets(address)).toEqual(hextets);
  });

  it('returns null for what is not IPv6', () => {
    expect(ipv6Hextets('127.0.0.1')).toBeNull();
    expect(ipv6Hextets('1::2::3')).toBeNull();
  });

  it('finds the IPv4 address in each carrying form, and none in a plain address', () => {
    const carried = (address: string) => embeddedIpv4(ipv6Hextets(address)!);
    expect(carried('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(carried('::ffff:0:a01:203')).toBe('10.1.2.3');
    expect(carried('64:ff9b::a01:203')).toBe('10.1.2.3');
    expect(carried('64:ff9b:1::a01:203')).toBe('10.1.2.3');
    expect(carried('2002:a01:203::')).toBe('10.1.2.3');
    expect(carried('2600::5efe:a01:203')).toBe('10.1.2.3');
    expect(carried('2606:4700:4700::1111')).toBeNull();
  });
});

describe('isBlockedHostname', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'localhost.',
    'localhost.localdomain',
    'api.localhost',
    'printer.local',
    'metadata.google.internal',
    'anything.internal',
  ])('refuses %s', (name) => {
    expect(isBlockedHostname(name)).toBe(true);
  });

  it.each(['example.com', 'localhost.example.com', 'internal.example.com', 'local'])(
    'lets %s through to the address check',
    (name) => {
      expect(isBlockedHostname(name)).toBe(false);
    }
  );
});

describe('refusalFor', () => {
  it("refuses a public address only when it is one of this machine's own", () => {
    // Control first: a public address the machine does not hold passes.
    fakeInterfaces.value = {};
    expect(refusalFor('2001:4860:4860::8888')).toBeNull();

    fakeInterfaces.value = {
      lo0: [{ address: '127.0.0.1' }, { address: '::1' }],
      en0: [{ address: '2001:4860:4860:0:0:0:0:8888' }, { address: 'fe80::1%en0' }],
    };
    expect(refusalFor('2001:4860:4860::8888')).toBe('this-machine');
    expect(refusalFor('2001:4860:4860::8844')).toBeNull();
    // A special-use range keeps its own name.
    expect(refusalFor('127.0.0.1')).toBe('loopback');
  });
});
