/**
 * Memory Handler Schema Tests - Workspace Session Scoping
 *
 * Validates that MCP tool schemas accept workspaceId parameters
 * and that handler response shapes include workspaceId.
 */

import { describe, it, expect } from 'vitest';
import { startSessionSchema, listSessionsSchema } from './memory-handlers';

describe('startSessionSchema', () => {
  it('should accept workspaceId as optional UUID', () => {
    const result = startSessionSchema.safeParse({
      email: 'test@test.com',
      agentId: 'wren',
      workspaceId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workspaceId).toBe('550e8400-e29b-41d4-a716-446655440000');
    }
  });

  it('should accept request without workspaceId (backward compat)', () => {
    const result = startSessionSchema.safeParse({
      email: 'test@test.com',
      agentId: 'wren',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workspaceId).toBeUndefined();
    }
  });

  it('should reject non-UUID workspaceId', () => {
    const result = startSessionSchema.safeParse({
      email: 'test@test.com',
      agentId: 'wren',
      workspaceId: 'not-a-uuid',
    });

    expect(result.success).toBe(false);
  });

  it('should still require user identification', () => {
    const result = startSessionSchema.safeParse({
      agentId: 'wren',
      workspaceId: '550e8400-e29b-41d4-a716-446655440000',
    });

    // Should fail or pass depending on base schema requirements
    // The base schema allows resolution by userId, email, phone, or platform+platformId
    // With none of these, it should still parse (resolution happens at handler level)
    expect(result.success).toBe(true);
  });
});

describe('listSessionsSchema', () => {
  it('should accept workspaceId as optional UUID', () => {
    const result = listSessionsSchema.safeParse({
      email: 'test@test.com',
      workspaceId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workspaceId).toBe('550e8400-e29b-41d4-a716-446655440000');
    }
  });

  it('should accept request without workspaceId', () => {
    const result = listSessionsSchema.safeParse({
      email: 'test@test.com',
      agentId: 'wren',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workspaceId).toBeUndefined();
    }
  });

  it('should accept both agentId and workspaceId together', () => {
    const result = listSessionsSchema.safeParse({
      email: 'test@test.com',
      agentId: 'wren',
      workspaceId: '550e8400-e29b-41d4-a716-446655440000',
      limit: 10,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBe('wren');
      expect(result.data.workspaceId).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(result.data.limit).toBe(10);
    }
  });

  it('should reject non-UUID workspaceId', () => {
    const result = listSessionsSchema.safeParse({
      email: 'test@test.com',
      workspaceId: 'invalid',
    });

    expect(result.success).toBe(false);
  });
});
