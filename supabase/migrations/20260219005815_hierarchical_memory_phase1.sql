-- Hierarchical Memory Phase 1: summary + topic_key columns, cache table
-- Spec: pcp://specs/hierarchical-memory (v3)

-- ============================================================================
-- 1. Add summary and topic_key columns to memories
-- ============================================================================

ALTER TABLE memories ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS topic_key TEXT;

-- Index for topic_key grouping queries (bootstrap knowledge summary)
CREATE INDEX IF NOT EXISTS idx_memories_topic_key ON memories (user_id, topic_key)
  WHERE topic_key IS NOT NULL;

-- ============================================================================
-- 2. Add summary and topic_key columns to memory_history
-- ============================================================================

ALTER TABLE memory_history ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE memory_history ADD COLUMN IF NOT EXISTS topic_key TEXT;

-- ============================================================================
-- 3. Update archive trigger functions to include new columns
-- ============================================================================

CREATE OR REPLACE FUNCTION public.archive_memory_on_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO memory_history (
    memory_id, user_id, content, source, salience, topics, metadata,
    version, created_at, change_type, summary, topic_key
  ) VALUES (
    OLD.id, OLD.user_id, OLD.content, OLD.source, OLD.salience, OLD.topics,
    OLD.metadata, OLD.version, OLD.created_at, 'delete', OLD.summary, OLD.topic_key
  );
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.archive_memory_on_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.content IS DISTINCT FROM NEW.content
     OR OLD.salience IS DISTINCT FROM NEW.salience
     OR OLD.topics IS DISTINCT FROM NEW.topics
     OR OLD.summary IS DISTINCT FROM NEW.summary
     OR OLD.topic_key IS DISTINCT FROM NEW.topic_key THEN
    INSERT INTO memory_history (
      memory_id, user_id, content, source, salience, topics, metadata,
      version, created_at, change_type, summary, topic_key
    ) VALUES (
      OLD.id, OLD.user_id, OLD.content, OLD.source, OLD.salience, OLD.topics,
      OLD.metadata, OLD.version, OLD.created_at, 'update', OLD.summary, OLD.topic_key
    );
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- 4. Memory summary cache table
-- ============================================================================

CREATE TABLE IF NOT EXISTS memory_summary_cache (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL DEFAULT '__shared__',
  summary_text TEXT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  memory_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, agent_id)
);

-- RLS: users can only read/write their own cache
ALTER TABLE memory_summary_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memory_summary_cache_user_access"
  ON memory_summary_cache
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Service role bypass for API server
CREATE POLICY "memory_summary_cache_service_role"
  ON memory_summary_cache
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
