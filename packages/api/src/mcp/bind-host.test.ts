import { describe, it, expect } from 'vitest';
import { isLoopbackHost } from './bind-host';
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
