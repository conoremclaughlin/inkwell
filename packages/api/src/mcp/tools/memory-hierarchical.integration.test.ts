/**
 * Hierarchical Memory Integration Tests
 *
 * Tests the full memory lifecycle against a real Supabase database:
 * 1. Create memories with summary + topicKey
 * 2. Verify summary/topicKey are stored and retrieved correctly
 * 3. getKnowledgeMemories returns critical + high salience
 * 4. buildKnowledgeSummary produces correct grouped output from real data
 * 5. Memory summary cache write + read + staleness
 * 6. Memory history preserves summary/topicKey on update/delete
 * 7. restoreMemory propagates summary/topicKey
 *
 * Run via: yarn workspace @inklabs/api test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { buildKnowledgeSummary } from './memory-handlers';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';

describe('Hierarchical Memory Integration', () => {
  let dataComposer: DataComposer;
  let testUserId: string;
  const createdMemoryIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    testUserId = fixture.userId;
  });

  afterAll(async () => {
    if (!dataComposer) return;

    // Clean up test memories
    if (createdMemoryIds.length > 0) {
      await dataComposer.getClient().from('memories').delete().in('id', createdMemoryIds);
    }

    // Clean up any memory history created by cascade
    await dataComposer
      .getClient()
      .from('memory_history')
      .delete()
      .in('memory_id', createdMemoryIds);

    // Clean up cache entries for test user + integration-test agent
    await dataComposer
      .getClient()
      .from('memory_summary_cache')
      .delete()
      .eq('user_id', testUserId)
      .eq('agent_id', 'integration-test');
  });

  // =========================================================================
  // 1. Create memories with summary + topicKey via repository
  // =========================================================================

  describe('remember with summary + topicKey', () => {
    it('should store and retrieve summary and topicKey', async () => {
      const memory = await dataComposer.repositories.memory.remember({
        userId: testUserId,
        content: 'Detailed explanation of self-issued JWT approach for MCP auth with 30-day expiry',
        summary: 'Self-issued JWTs for MCP auth',
        topicKey: 'decision:jwt-auth',
        source: 'session',
        salience: 'high',
        topics: ['auth', 'mcp'],
        agentId: 'integration-test',
      });

      createdMemoryIds.push(memory.id);

      expect(memory.summary).toBe('Self-issued JWTs for MCP auth');
      expect(memory.topicKey).toBe('decision:jwt-auth');

      // Verify topicKey was auto-prepended to topics
      expect(memory.topics).toContain('decision:jwt-auth');
      expect(memory.topics).toContain('auth');
      expect(memory.topics).toContain('mcp');
    });

    it('should store memory without summary/topicKey (backward compat)', async () => {
      const memory = await dataComposer.repositories.memory.remember({
        userId: testUserId,
        content: 'A plain memory without the new fields',
        source: 'observation',
        salience: 'medium',
        agentId: 'integration-test',
      });

      createdMemoryIds.push(memory.id);

      expect(memory.summary).toBeUndefined();
      expect(memory.topicKey).toBeUndefined();
    });

    it('should persist summary/topicKey to the actual database row', async () => {
      const memory = await dataComposer.repositories.memory.remember({
        userId: testUserId,
        content: 'Git conventions: always feature branch + PR',
        summary: 'Never push directly to main',
        topicKey: 'convention:git',
        source: 'user_stated',
        salience: 'critical',
        agentId: 'integration-test',
      });

      createdMemoryIds.push(memory.id);

      // Read raw row from DB to verify column values
      const { data: row } = await dataComposer
        .getClient()
        .from('memories')
        .select('summary, topic_key')
        .eq('id', memory.id)
        .single();

      expect(row).not.toBeNull();
      expect(row!.summary).toBe('Never push directly to main');
      expect(row!.topic_key).toBe('convention:git');
    });
  });

  // =========================================================================
  // 2. getKnowledgeMemories
  // =========================================================================

  describe('getKnowledgeMemories', () => {
    let criticalMemId: string;
    let highMemId: string;
    let mediumMemId: string;

    beforeAll(async () => {
      // Create memories at different salience levels
      const critical = await dataComposer.repositories.memory.remember({
        userId: testUserId,
        content: 'Critical: core identity fact',
        summary: 'Core identity',
        topicKey: 'identity:test',
        salience: 'critical',
        agentId: 'integration-test',
      });
      criticalMemId = critical.id;
      createdMemoryIds.push(critical.id);

      const high = await dataComposer.repositories.memory.remember({
        userId: testUserId,
        content: 'High: important decision',
        summary: 'Important decision',
        topicKey: 'decision:test',
        salience: 'high',
        agentId: 'integration-test',
      });
      highMemId = high.id;
      createdMemoryIds.push(high.id);

      const medium = await dataComposer.repositories.memory.remember({
        userId: testUserId,
        content: 'Medium: routine observation',
        salience: 'medium',
        agentId: 'integration-test',
      });
      mediumMemId = medium.id;
      createdMemoryIds.push(medium.id);
    });

    it('should return critical and high salience memories', async () => {
      const memories = await dataComposer.repositories.memory.getKnowledgeMemories(
        testUserId,
        'integration-test'
      );

      const ids = memories.map((m) => m.id);
      expect(ids).toContain(criticalMemId);
      expect(ids).toContain(highMemId);
      // Medium should NOT be included
      expect(ids).not.toContain(mediumMemId);
    });

    it('should return critical memories before high memories', async () => {
      const memories = await dataComposer.repositories.memory.getKnowledgeMemories(
        testUserId,
        'integration-test'
      );

      const criticalIdx = memories.findIndex((m) => m.id === criticalMemId);
      const highIdx = memories.findIndex((m) => m.id === highMemId);

      // Critical should appear before high (lower index)
      expect(criticalIdx).toBeLessThan(highIdx);
    });

    it('should include summary and topicKey in results', async () => {
      const memories = await dataComposer.repositories.memory.getKnowledgeMemories(
        testUserId,
        'integration-test'
      );

      const critical = memories.find((m) => m.id === criticalMemId);
      expect(critical).toBeDefined();
      expect(critical!.summary).toBe('Core identity');
      expect(critical!.topicKey).toBe('identity:test');
    });
  });

  // =========================================================================
  // 3. buildKnowledgeSummary with real data
  // =========================================================================

  describe('buildKnowledgeSummary with real memories', () => {
    it('should produce grouped summary from getKnowledgeMemories output', async () => {
      const memories = await dataComposer.repositories.memory.getKnowledgeMemories(
        testUserId,
        'integration-test'
      );

      const result = buildKnowledgeSummary(memories);

      // Should have a non-empty summary
      expect(result.knowledgeSummary.length).toBeGreaterThan(0);

      // Should have topic index entries
      expect(result.topicIndex.length).toBeGreaterThan(0);

      // Our test topics should appear in the index
      const topicKeys = result.topicIndex.map((t) => t.topicKey);
      expect(topicKeys).toContain('identity:test');
      expect(topicKeys).toContain('decision:test');

      // Summary text should contain our test summaries
      expect(result.knowledgeSummary).toContain('Core identity');
      expect(result.knowledgeSummary).toContain('Important decision');
    });
  });

  // =========================================================================
  // 4. Memory summary cache
  // =========================================================================

  describe('memory summary cache', () => {
    it('should write and read cached summary', async () => {
      const summaryText = 'Integration test summary content';
      const memoryCount = 42;

      await dataComposer.repositories.memory.setCachedSummary(
        testUserId,
        'integration-test',
        summaryText,
        memoryCount
      );

      // Read it back — but it will be stale because our test memories are newer
      // than the cache we just wrote. So test the raw DB read instead.
      const { data: row } = await dataComposer
        .getClient()
        .from('memory_summary_cache')
        .select('*')
        .eq('user_id', testUserId)
        .eq('agent_id', 'integration-test')
        .single();

      expect(row).not.toBeNull();
      expect(row!.summary_text).toBe(summaryText);
      expect(row!.memory_count).toBe(memoryCount);
    });

    it('should return null when cache is stale (newer memories exist)', async () => {
      // Write cache
      await dataComposer.repositories.memory.setCachedSummary(
        testUserId,
        'integration-test',
        'Old cached summary',
        10
      );

      // Create a new memory (makes cache stale)
      const newMem = await dataComposer.repositories.memory.remember({
        userId: testUserId,
        content: 'New memory that invalidates cache',
        salience: 'high',
        agentId: 'integration-test',
      });
      createdMemoryIds.push(newMem.id);

      // Cache should be stale
      const cached = await dataComposer.repositories.memory.getCachedSummary(
        testUserId,
        'integration-test'
      );
      expect(cached).toBeNull();
    });

    it('should upsert (update existing cache entry)', async () => {
      await dataComposer.repositories.memory.setCachedSummary(
        testUserId,
        'integration-test',
        'First version',
        5
      );
      await dataComposer.repositories.memory.setCachedSummary(
        testUserId,
        'integration-test',
        'Updated version',
        10
      );

      const { data: row } = await dataComposer
        .getClient()
        .from('memory_summary_cache')
        .select('summary_text, memory_count')
        .eq('user_id', testUserId)
        .eq('agent_id', 'integration-test')
        .single();

      expect(row!.summary_text).toBe('Updated version');
      expect(row!.memory_count).toBe(10);
    });
  });

  // =========================================================================
  // 5. Memory history preserves summary/topicKey
  // =========================================================================

  describe('memory history with summary/topicKey', () => {
    it('should archive summary/topicKey on update', async () => {
      // Create a memory with summary + topicKey
      const memory = await dataComposer.repositories.memory.remember({
        userId: testUserId,
        content: 'Original content for history test',
        summary: 'Original summary',
        topicKey: 'test:history',
        salience: 'high',
        agentId: 'integration-test',
      });
      createdMemoryIds.push(memory.id);

      // Update it (triggers archive_memory_on_update)
      await dataComposer.repositories.memory.updateMemory(memory.id, testUserId, {
        salience: 'critical',
      });

      // Check that history entry has the original summary/topicKey
      const { data: historyRows } = await dataComposer
        .getClient()
        .from('memory_history')
        .select('summary, topic_key, change_type')
        .eq('memory_id', memory.id)
        .order('archived_at', { ascending: false });

      expect(historyRows).not.toBeNull();
      expect(historyRows!.length).toBeGreaterThan(0);

      const latest = historyRows![0];
      expect(latest.summary).toBe('Original summary');
      expect(latest.topic_key).toBe('test:history');
      expect(latest.change_type).toBe('update');
    });

    it('should archive summary/topicKey on delete', async () => {
      const memory = await dataComposer.repositories.memory.remember({
        userId: testUserId,
        content: 'Content to be deleted',
        summary: 'Delete test summary',
        topicKey: 'test:delete-history',
        salience: 'medium',
        agentId: 'integration-test',
      });
      createdMemoryIds.push(memory.id);

      // Delete the memory (triggers archive_memory_on_delete)
      await dataComposer.repositories.memory.forget(memory.id, testUserId);

      // Check history
      const { data: historyRows } = await dataComposer
        .getClient()
        .from('memory_history')
        .select('summary, topic_key, change_type')
        .eq('memory_id', memory.id);

      expect(historyRows).not.toBeNull();
      expect(historyRows!.length).toBeGreaterThan(0);

      const deleteEntry = historyRows!.find((h) => h.change_type === 'delete');
      expect(deleteEntry).toBeDefined();
      expect(deleteEntry!.summary).toBe('Delete test summary');
      expect(deleteEntry!.topic_key).toBe('test:delete-history');
    });
  });

  // =========================================================================
  // 6. restoreMemory propagates summary/topicKey
  // =========================================================================

  describe('restoreMemory with summary/topicKey', () => {
    it('should restore summary/topicKey from history to existing memory', async () => {
      // Create memory with summary + topicKey
      const memory = await dataComposer.repositories.memory.remember({
        userId: testUserId,
        content: 'Original content',
        summary: 'Original restore summary',
        topicKey: 'test:restore',
        salience: 'high',
        agentId: 'integration-test',
      });
      createdMemoryIds.push(memory.id);

      // Update it to create a history entry (changes content, clearing summary)
      const { data: updated } = await dataComposer
        .getClient()
        .from('memories')
        .update({ content: 'Updated content', summary: 'Changed summary' })
        .eq('id', memory.id)
        .select()
        .single();
      expect(updated).not.toBeNull();

      // Get the history entry
      const { data: historyRows } = await dataComposer
        .getClient()
        .from('memory_history')
        .select('id, summary, topic_key')
        .eq('memory_id', memory.id)
        .order('archived_at', { ascending: false })
        .limit(1);

      expect(historyRows).not.toBeNull();
      expect(historyRows!.length).toBe(1);

      const historyEntry = historyRows![0];
      expect(historyEntry.summary).toBe('Original restore summary');
      expect(historyEntry.topic_key).toBe('test:restore');

      // Restore from history
      const restored = await dataComposer.repositories.memory.restoreMemory(
        historyEntry.id,
        testUserId
      );

      expect(restored).not.toBeNull();
      expect(restored!.content).toBe('Original content');
      expect(restored!.summary).toBe('Original restore summary');
      expect(restored!.topicKey).toBe('test:restore');
    });

    it('should restore summary/topicKey when recreating deleted memory', async () => {
      // Create and delete
      const memory = await dataComposer.repositories.memory.remember({
        userId: testUserId,
        content: 'Content to delete and restore',
        summary: 'Restore from deleted',
        topicKey: 'test:restore-deleted',
        salience: 'high',
        agentId: 'integration-test',
      });
      // Don't track in createdMemoryIds yet — it will be deleted

      await dataComposer.repositories.memory.forget(memory.id, testUserId);

      // Get history entry
      const { data: historyRows } = await dataComposer
        .getClient()
        .from('memory_history')
        .select('id')
        .eq('memory_id', memory.id)
        .eq('change_type', 'delete')
        .limit(1);

      expect(historyRows).not.toBeNull();
      expect(historyRows!.length).toBe(1);

      // Restore (creates new memory since original was deleted)
      const restored = await dataComposer.repositories.memory.restoreMemory(
        historyRows![0].id,
        testUserId
      );

      expect(restored).not.toBeNull();
      createdMemoryIds.push(restored!.id);

      expect(restored!.content).toBe('Content to delete and restore');
      expect(restored!.summary).toBe('Restore from deleted');
      expect(restored!.topicKey).toBe('test:restore-deleted');
    });
  });
});
