-- Task comments: threaded discussion on individual tasks
-- Follows the same pattern as artifact_comments

CREATE TABLE IF NOT EXISTS public.task_comments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id),
  workspace_id uuid REFERENCES public.workspaces(id),
  parent_comment_id uuid REFERENCES public.task_comments(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_by_agent_id text,
  created_by_identity_id uuid REFERENCES public.agent_identities(id),
  metadata jsonb DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_task_comments_task_id ON public.task_comments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_comments_user_id ON public.task_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_task_comments_parent ON public.task_comments(parent_comment_id);

-- updated_at trigger
CREATE TRIGGER set_task_comments_updated_at
  BEFORE UPDATE ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE public.task_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "task_comments_service_full_access"
  ON public.task_comments FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
