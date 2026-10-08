import { beforeEach, describe, expect, it, vi } from 'vitest';

type Result = { data: unknown; error: { message: string } | null };

const db = vi.hoisted(() => ({
  results: {} as Record<string, Result>,
  filters: [] as Array<{ table: string; column: string; value: unknown }>,
  clientOptions: [] as unknown[],
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((_url: string, _key: string, options?: unknown) => {
    db.clientOptions.push(options);
    return {
      from: (table: string) => {
        const builder = {
          select: () => builder,
          eq: (column: string, value: unknown) => {
            db.filters.push({ table, column, value });
            return builder;
          },
          maybeSingle: async () => db.results[table] ?? { data: null, error: null },
        };
        return builder;
      },
    };
  }),
}));

import { PermissionsService } from './permissions';

const USER = '00000000-0000-4000-8000-000000000002';
const hourFromNow = () => new Date(Date.now() + 3_600_000).toISOString();
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

describe('PermissionsService.isEnabled', () => {
  beforeEach(() => {
    db.results = {};
    db.filters = [];
  });

  it('builds its client without a persisted session', () => {
    new PermissionsService();
    expect(db.clientOptions.at(-1)).toEqual({
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  it('reads the one override for this user and permission', async () => {
    db.results.user_permissions = { data: { enabled: false, expires_at: null }, error: null };
    await expect(new PermissionsService().isEnabled(USER, 'web_fetch', true)).resolves.toBe(false);
    expect(db.filters).toEqual([
      { table: 'user_permissions', column: 'user_id', value: USER },
      { table: 'user_permissions', column: 'permission_id', value: 'web_fetch' },
    ]);
  });

  it('honours an override that has not expired', async () => {
    db.results.user_permissions = {
      data: { enabled: false, expires_at: hourFromNow() },
      error: null,
    };
    db.results.permission_definitions = { data: { default_enabled: true }, error: null };
    await expect(new PermissionsService().isEnabled(USER, 'web_fetch', true)).resolves.toBe(false);
  });

  it('falls to the definition when the override has expired', async () => {
    db.results.user_permissions = { data: { enabled: false, expires_at: hourAgo() }, error: null };
    db.results.permission_definitions = { data: { default_enabled: true }, error: null };
    await expect(new PermissionsService().isEnabled(USER, 'web_fetch', false)).resolves.toBe(true);
  });

  it("uses the definition's default with no override", async () => {
    db.results.permission_definitions = { data: { default_enabled: false }, error: null };
    await expect(new PermissionsService().isEnabled(USER, 'web_fetch', true)).resolves.toBe(false);
  });

  it('uses the fallback when there is no definition row', async () => {
    await expect(new PermissionsService().isEnabled(USER, 'web_fetch', true)).resolves.toBe(true);
    await expect(new PermissionsService().isEnabled(USER, 'web_fetch', false)).resolves.toBe(false);
  });

  it('throws when the override cannot be read, rather than reading it as none', async () => {
    db.results.user_permissions = { data: null, error: { message: 'connection reset' } };
    db.results.permission_definitions = { data: { default_enabled: true }, error: null };
    await expect(new PermissionsService().isEnabled(USER, 'web_fetch', true)).rejects.toThrow(
      'Could not read the web_fetch permission: connection reset'
    );
  });

  it('throws when the definition cannot be read, rather than using the fallback', async () => {
    db.results.permission_definitions = { data: null, error: { message: 'timeout' } };
    await expect(new PermissionsService().isEnabled(USER, 'web_fetch', true)).rejects.toThrow(
      "Could not read the web_fetch permission's default: timeout"
    );
  });
});
