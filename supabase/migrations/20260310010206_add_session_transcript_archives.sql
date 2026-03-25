-- Persist full backend transcripts in Postgres for cross-server session log portability.
-- Stores one jsonb payload per PCP session (manual sync on demand).

CREATE TABLE IF NOT EXISTS session_transcript_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  backend text,
  backend_session_id text,
  payload jsonb NOT NULL,
  line_count integer NOT NULL DEFAULT 0,
  byte_count integer NOT NULL DEFAULT 0,
  source_path text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_transcript_archives_line_count_non_negative CHECK (line_count >= 0),
  CONSTRAINT session_transcript_archives_byte_count_non_negative CHECK (byte_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_transcript_archives_session_id
  ON session_transcript_archives(session_id);

CREATE INDEX IF NOT EXISTS idx_session_transcript_archives_user_synced_at
  ON session_transcript_archives(user_id, synced_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_transcript_archives_backend_session
  ON session_transcript_archives(backend, backend_session_id)
  WHERE backend_session_id IS NOT NULL;

DROP TRIGGER IF EXISTS session_transcript_archives_updated_at ON session_transcript_archives;
CREATE TRIGGER session_transcript_archives_updated_at
  BEFORE UPDATE ON session_transcript_archives
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE session_transcript_archives ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to session_transcript_archives" ON session_transcript_archives;
CREATE POLICY "Service role full access to session_transcript_archives"
  ON session_transcript_archives FOR ALL
  USING ((auth.jwt() ->> 'role') = 'service_role')
  WITH CHECK ((auth.jwt() ->> 'role') = 'service_role');

DROP POLICY IF EXISTS "Users can view own session transcript archives" ON session_transcript_archives;
CREATE POLICY "Users can view own session transcript archives"
  ON session_transcript_archives FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own session transcript archives" ON session_transcript_archives;
CREATE POLICY "Users can insert own session transcript archives"
  ON session_transcript_archives FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own session transcript archives" ON session_transcript_archives;
CREATE POLICY "Users can update own session transcript archives"
  ON session_transcript_archives FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own session transcript archives" ON session_transcript_archives;
CREATE POLICY "Users can delete own session transcript archives"
  ON session_transcript_archives FOR DELETE
  USING (auth.uid() = user_id);

COMMENT ON TABLE session_transcript_archives IS
  'Full backend transcript snapshots synced on demand for cross-server portability.';

COMMENT ON COLUMN session_transcript_archives.payload IS
  'Full transcript payload stored as jsonb (JSONL lines parsed into JSON objects when possible).';
