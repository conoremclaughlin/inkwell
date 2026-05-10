-- Recall feedback: stores SB curation decisions (accept/dismiss) for recalled
-- memories, with the cosine similarity scores at the time of recall.
-- Phase 1: durable storage. Phase 2+: frequency-based penalty in recall ranking.

CREATE TABLE recall_feedback (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id text,
  query text NOT NULL,
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  verdict text NOT NULL CHECK (verdict IN ('accepted', 'dismissed')),
  semantic_score double precision,
  text_score double precision,
  final_score double precision,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_recall_feedback_memory ON recall_feedback (memory_id);
CREATE INDEX idx_recall_feedback_user_agent ON recall_feedback (user_id, agent_id);

ALTER TABLE recall_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on recall_feedback"
  ON recall_feedback FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
