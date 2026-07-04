import { describe, it, expect } from 'vitest';
import { resolveCredentialRefs } from './credential-resolver.js';

const testEnv: Record<string, string> = {
  TEST_USER: 'alice',
  TEST_PASS: 's3cret',
  TEST_HOST: 'example.com',
  TEST_PORT: '8080',
};

describe('resolveCredentialRefs', () => {
  it('resolves bare $VAR references', () => {
    const { args, resolutions } = resolveCredentialRefs(
      { username: '$TEST_USER', password: '$TEST_PASS' },
      testEnv
    );
    expect(args.username).toBe('alice');
    expect(args.password).toBe('s3cret');
    expect(resolutions).toHaveLength(2);
    expect(resolutions[0]).toEqual({ name: 'TEST_USER', path: 'username' });
    expect(resolutions[1]).toEqual({ name: 'TEST_PASS', path: 'password' });
  });

  it('resolves bare ${VAR} braced references', () => {
    const { args } = resolveCredentialRefs({ host: '${TEST_HOST}' }, testEnv);
    expect(args.host).toBe('example.com');
  });

  it('does NOT resolve embedded references in longer strings', () => {
    const { args, resolutions } = resolveCredentialRefs(
      { url: 'https://${TEST_HOST}:${TEST_PORT}/api' },
      testEnv
    );
    expect(args.url).toBe('https://${TEST_HOST}:${TEST_PORT}/api');
    expect(resolutions).toHaveLength(0);
  });

  it('does NOT interpolate references embedded in text', () => {
    const { args, resolutions } = resolveCredentialRefs(
      { greeting: 'Hello $TEST_USER, welcome!' },
      testEnv
    );
    expect(args.greeting).toBe('Hello $TEST_USER, welcome!');
    expect(resolutions).toHaveLength(0);
  });

  it('leaves unresolvable bare references as-is', () => {
    const { args, resolutions } = resolveCredentialRefs({ value: '$NONEXISTENT_VAR' }, testEnv);
    expect(args.value).toBe('$NONEXISTENT_VAR');
    expect(resolutions).toHaveLength(0);
  });

  it('passes through non-string values unchanged', () => {
    const { args, resolutions } = resolveCredentialRefs(
      { count: 42, enabled: true, data: null },
      testEnv
    );
    expect(args.count).toBe(42);
    expect(args.enabled).toBe(true);
    expect(args.data).toBe(null);
    expect(resolutions).toHaveLength(0);
  });

  it('walks nested objects recursively', () => {
    const { args, resolutions } = resolveCredentialRefs(
      {
        credentials: {
          user: '$TEST_USER',
          auth: { password: '$TEST_PASS' },
        },
      },
      testEnv
    );
    const creds = args.credentials as Record<string, unknown>;
    expect(creds.user).toBe('alice');
    const auth = creds.auth as Record<string, unknown>;
    expect(auth.password).toBe('s3cret');
    expect(resolutions).toEqual([
      { name: 'TEST_USER', path: 'credentials.user' },
      { name: 'TEST_PASS', path: 'credentials.auth.password' },
    ]);
  });

  it('walks arrays recursively', () => {
    const { args, resolutions } = resolveCredentialRefs(
      { hosts: ['$TEST_HOST', 'static.example.com'] },
      testEnv
    );
    expect(args.hosts).toEqual(['example.com', 'static.example.com']);
    expect(resolutions).toEqual([{ name: 'TEST_HOST', path: 'hosts[0]' }]);
  });

  it('does NOT resolve multi-reference strings (not bare)', () => {
    const { args, resolutions } = resolveCredentialRefs(
      { dsn: '$TEST_USER:$TEST_PASS@$TEST_HOST' },
      testEnv
    );
    expect(args.dsn).toBe('$TEST_USER:$TEST_PASS@$TEST_HOST');
    expect(resolutions).toHaveLength(0);
  });

  it('returns empty resolutions for args with no references', () => {
    const { args, resolutions } = resolveCredentialRefs(
      { url: 'https://example.com', count: 5 },
      testEnv
    );
    expect(args.url).toBe('https://example.com');
    expect(resolutions).toHaveLength(0);
  });

  it('does not mutate the original args object', () => {
    const original = { user: '$TEST_USER', nested: { pass: '$TEST_PASS' } };
    const originalJson = JSON.stringify(original);
    resolveCredentialRefs(original, testEnv);
    expect(JSON.stringify(original)).toBe(originalJson);
  });

  it('handles empty args', () => {
    const { args, resolutions } = resolveCredentialRefs({}, testEnv);
    expect(args).toEqual({});
    expect(resolutions).toHaveLength(0);
  });

  it('resolves from real process.env when no env override', () => {
    process.env.INK_TEST_LIVE_CRED = 'live-value-123';
    try {
      const { args, resolutions } = resolveCredentialRefs({
        token: '$INK_TEST_LIVE_CRED',
      });
      expect(args.token).toBe('live-value-123');
      expect(resolutions).toEqual([{ name: 'INK_TEST_LIVE_CRED', path: 'token' }]);
    } finally {
      delete process.env.INK_TEST_LIVE_CRED;
    }
  });

  it('does NOT resolve known credential names embedded in text fields', () => {
    const keychainOnly: Record<string, string> = { GFIBER_PASSWORD: 'super-secret' };
    const { args, resolutions } = resolveCredentialRefs(
      {
        content: 'Please use $GFIBER_PASSWORD literally',
        password: '$GFIBER_PASSWORD',
      },
      keychainOnly
    );
    expect(args.content).toBe('Please use $GFIBER_PASSWORD literally');
    expect(args.password).toBe('super-secret');
    expect(resolutions).toEqual([{ name: 'GFIBER_PASSWORD', path: 'password' }]);
  });

  it('does NOT resolve $VAR references absent from the provided env', () => {
    const keychainOnly: Record<string, string> = { GFIBER_PASSWORD: 'secret123' };
    const { args, resolutions } = resolveCredentialRefs(
      {
        content: 'Please use $API_TOKEN in your config and set $HOME correctly',
        password: '$GFIBER_PASSWORD',
      },
      keychainOnly
    );
    expect(args.content).toBe('Please use $API_TOKEN in your config and set $HOME correctly');
    expect(args.password).toBe('secret123');
    expect(resolutions).toEqual([{ name: 'GFIBER_PASSWORD', path: 'password' }]);
  });
});
