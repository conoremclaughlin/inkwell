-- Task group comments table + task/task_group outcome fields
-- Mirrors artifact_comments pattern for auditable group lifecycle tracking

CREATE TABLE public.task_group_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_group_id uuid NOT NULL REFERENCES public.task_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id),
  agent_id text,
  comment_type text NOT NULL DEFAULT 'comment'
    CHECK (comment_type IN ('comment', 'conclusion', 'status_change')),
  content text NOT NULL,
  created_by_identity_id uuid REFERENCES public.agent_identities(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_task_group_comments_task_group_id ON public.task_group_comments(task_group_id);
CREATE INDEX idx_task_group_comments_user_id ON public.task_group_comments(user_id);
CREATE INDEX idx_task_group_comments_agent_id ON public.task_group_comments(agent_id);
CREATE INDEX idx_task_group_comments_comment_type ON public.task_group_comments(comment_type);
CREATE INDEX idx_task_group_comments_created_by_identity_id ON public.task_group_comments(created_by_identity_id);

CREATE TRIGGER update_task_group_comments_updated_at
  BEFORE UPDATE ON public.task_group_comments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.task_group_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to task_group_comments"
  ON public.task_group_comments FOR ALL
  USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

-- Task outcome fields: close with outcome instead of binary complete
ALTER TABLE public.tasks
  ADD COLUMN outcome text CHECK (outcome IN ('completed', 'skipped', 'blocked', 'failed')),
  ADD COLUMN outcome_reason text;

-- Task group outcome/conclusion for auditable closure
ALTER TABLE public.task_groups
  ADD COLUMN outcome text CHECK (outcome IN ('completed', 'partial', 'abandoned', 'failed')),
  ADD COLUMN conclusion text;
