import { describe, it, expect } from 'vitest';
import { isLoopbackHost, resolveBindHost, DEFAULT_BIND_HOST } from './bind-host';
import { envSchema } from '../config/env';

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '::1', 'localhost', 'LOCALHOST', '  127.0.0.1  '])(
    'treats %s as host-only',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    }
  );

  // The case the whole fix exists for: 0.0.0.0 binds every interface, so it is
  // emphatically not loopback even though it is spelled like an address nobody
  // else can reach.
  it.each(['0.0.0.0', '::', '192.168.86.60', '10.0.0.4', ''])(
    'treats %s as network-reachable',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    }
  );
});

describe('resolveBindHost', () => {
  // The zod schema supplies a default, but config does not always come through
  // it: several suites build `env` by hand. `listen(port, undefined)` binds
  // every interface, so an absent value has to fail CLOSED.
  it.each([undefined, null, '', '   '])('falls back to loopback for %p', (configured) => {
    expect(resolveBindHost(configured as string | undefined)).toBe(DEFAULT_BIND_HOST);
    expect(isLoopbackHost(resolveBindHost(configured as string | undefined))).toBe(true);
  });

  it('honours an explicit off-host bind', () => {
    expect(resolveBindHost('0.0.0.0')).toBe('0.0.0.0');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveBindHost('  ::1  ')).toBe('::1');
  });
});

describe('MCP_BIND_HOST default', () => {
  // Asserted against the real zod schema, not the mocked `env` object the
  // server tests use — a mock would only prove what the mock was written to say.
  it('defaults to loopback when unset', () => {
    expect(envSchema.shape.MCP_BIND_HOST.parse(undefined)).toBe('127.0.0.1');
  });

  it('is overridable for containers', () => {
    expect(envSchema.shape.MCP_BIND_HOST.parse('0.0.0.0')).toBe('0.0.0.0');
  });
});
