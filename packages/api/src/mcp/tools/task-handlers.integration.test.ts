/**
 * Task Handlers — Integration Tests
 *
 * Exercises handleUpdateTaskGroup against the real Supabase database.
 * The repository-level `update()` is already covered by unit tests with
 * mocks; this test verifies the MCP handler end-to-end: real DB insert,
 * real update, real metadata merge behavior.
 *
 * Requires:
 *   - .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY
 *   - ~/.ink/config.json with userId
 *
 * Skipped automatically in CI / when credentials are unavailable.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const projectRoot = resolve(__dirname, '../../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

if (!process.env.PCP_PORT_BASE) process.env.PCP_PORT_BASE = '9997';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;

const configPath = resolve(process.env.HOME || '', '.ink/config.json');
const inkConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};
const TEST_USER_ID: string | undefined = inkConfig.userId;

const canRun = !!SUPABASE_URL && !!SUPABASE_KEY && !!TEST_USER_ID;

// Bypass auth helpers that require request context in a server
vi.mock('../../auth/enforce-identity', () => ({
  getEffectiveAgentId: vi.fn().mockReturnValue('wren'),
}));
vi.mock('../../utils/request-context', () => ({
  setSessionContext: vi.fn(),
  pinSessionAgent: vi.fn(),
  getPinnedAgentId: vi.fn().mockReturnValue(null),
  getRequestContext: vi.fn().mockReturnValue(undefined),
}));
// resolveUser is normally called via OAuth context; short-circuit it.
vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/user-resolver')>();
  return {
    ...actual,
    resolveUser: vi.fn(async (args: { userId?: string }) => {
      if (!args.userId) return null;
      return { user: { id: args.userId } as any, resolvedBy: 'userId' as const };
    }),
  };
});

describe.skipIf(!canRun)('handleUpdateTaskGroup (integration)', () => {
  let client: SupabaseClient;
  let dc: any;
  const createdGroupIds: string[] = [];

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { TaskGroupsRepository } = await import('../../data/repositories/task-groups.repository');

    dc = {
      getClient: () => client,
      repositories: {
        taskGroups: new TaskGroupsRepository(client),
        projects: { findById: vi.fn().mockResolvedValue(null) },
      },
    };
  }, 15_000);

  afterAll(async () => {
    if (!client || createdGroupIds.length === 0) return;
    await client.from('task_groups').delete().in('id', createdGroupIds);
  }, 10_000);

  async function seedGroup(
    overrides: Partial<Parameters<typeof dc.repositories.taskGroups.create>[0]> = {}
  ): Promise<string> {
    const group = await dc.repositories.taskGroups.create({
      user_id: TEST_USER_ID!,
      title: `__update_integration_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      description: 'Integration test — safe to delete',
      priority: 'low',
      tags: ['__test'],
      metadata: { seeded: true },
      ...overrides,
    });
    createdGroupIds.push(group.id);
    return group.id;
  }

  it('closes a group with status + closedReason, persisting to the real DB', async () => {
    const { handleUpdateTaskGroup } = await import('./task-handlers');
    const groupId = await seedGroup();

    const response = await handleUpdateTaskGroup(
      {
        userId: TEST_USER_ID!,
        groupId,
        status: 'completed',
        closedReason: 'Shipped via integration test',
      } as any,
      dc
    );
    expect(response.isError).toBeFalsy();

    const { data } = await client
      .from('task_groups')
      .select('status, metadata')
      .eq('id', groupId)
      .single();

    expect(data?.status).toBe('completed');
    expect(data?.metadata).toMatchObject({
      seeded: true,
      closed_reason: 'Shipped via integration test',
    });
  });

  it('merges metadata by default, preserving pre-existing keys', async () => {
    const { handleUpdateTaskGroup } = await import('./task-handlers');
    const groupId = await seedGroup();

    await handleUpdateTaskGroup(
      {
        userId: TEST_USER_ID!,
        groupId,
        metadata: { studioSlug: 'wren-omega' },
      } as any,
      dc
    );

    const { data } = await client.from('task_groups').select('metadata').eq('id', groupId).single();

    expect(data?.metadata).toMatchObject({ seeded: true, studioSlug: 'wren-omega' });
  });

  it('replaces metadata when mergeMetadata is false', async () => {
    const { handleUpdateTaskGroup } = await import('./task-handlers');
    const groupId = await seedGroup();

    await handleUpdateTaskGroup(
      {
        userId: TEST_USER_ID!,
        groupId,
        metadata: { onlyThis: true },
        mergeMetadata: false,
      } as any,
      dc
    );

    const { data } = await client.from('task_groups').select('metadata').eq('id', groupId).single();

    expect(data?.metadata).toEqual({ onlyThis: true });
    expect((data?.metadata as Record<string, unknown>)?.seeded).toBeUndefined();
  });

  it('refuses to update a group owned by a different user', async () => {
    const { handleUpdateTaskGroup } = await import('./task-handlers');
    const groupId = await seedGroup();

    const response = await handleUpdateTaskGroup(
      {
        userId: '00000000-0000-0000-0000-000000000999',
        groupId,
        status: 'cancelled',
      } as any,
      dc
    );

    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0].text);
    // resolveUser short-circuits on unknown userId → 'User not found'.
    // If a real user happened to own this ID, ownership check fires instead —
    // we accept either as valid rejection.
    expect(['User not found', 'Task group does not belong to this user']).toContain(body.error);

    const { data } = await client.from('task_groups').select('status').eq('id', groupId).single();
    expect(data?.status).toBe('active');
  });

  it('rejects identityId that is not in agent_identities for this user', async () => {
    const { handleUpdateTaskGroup } = await import('./task-handlers');
    const groupId = await seedGroup();

    const response = await handleUpdateTaskGroup(
      {
        userId: TEST_USER_ID!,
        groupId,
        // Valid UUID format, but will not match any row scoped to TEST_USER_ID.
        identityId: '00000000-0000-4000-a000-000000000000',
      } as any,
      dc
    );

    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0].text);
    expect(body.error).toBe('identityId not found or does not belong to this user/workspace.');

    // Confirm no partial write — identity_id is still null.
    const { data } = await client
      .from('task_groups')
      .select('identity_id')
      .eq('id', groupId)
      .single();
    expect(data?.identity_id).toBeNull();
  });

  it('accepts a real identityId that belongs to this user', async () => {
    const { handleUpdateTaskGroup } = await import('./task-handlers');

    // Find any agent identity belonging to the test user — any real row works
    // to exercise the accept path against the real DB.
    const { data: identity } = await client
      .from('agent_identities')
      .select('id')
      .eq('user_id', TEST_USER_ID!)
      .limit(1)
      .single();

    if (!identity) {
      // No agent_identities rows for this user — skip rather than flake.
      return;
    }

    const groupId = await seedGroup();

    const response = await handleUpdateTaskGroup(
      {
        userId: TEST_USER_ID!,
        groupId,
        identityId: identity.id,
      } as any,
      dc
    );

    expect(response.isError).toBeFalsy();

    const { data } = await client
      .from('task_groups')
      .select('identity_id')
      .eq('id', groupId)
      .single();
    expect(data?.identity_id).toBe(identity.id);
  });
});
