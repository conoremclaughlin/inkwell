-- Thread-key type registry (grammar v2, Phase 6a — thread:studio-write-intent).
--
-- The v1 grammar made the type registry a code constant. Conor's call
-- (2026-08-20): the registry is DATA — general rules like "pr:* creates a
-- studio" must be adjustable without a deploy, and the system ships templates
-- that work out of the box.
--
-- Two behavior axes per type, deliberately only two (the materialization
-- review's don't-conflate-axes lesson):
--   write_intent : does a session on this thread type take the studio write
--                  lease at spawn? ('write') or run as presence ('presence')
--   studio_policy: may routing PROVISION worktrees for this type ('provision')
--                  or must it run in an existing studio / main ('reuse-only')
--
-- Execution environment (host vs container) is NOT here — that is studio/
-- sandbox configuration, a different axis on a different object.

CREATE TABLE public.thread_key_types (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- NULL = system template row; non-null = per-user override of that type.
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type ~ '^[a-z0-9][a-z0-9-]*$'),
  write_intent text NOT NULL CHECK (write_intent IN ('write', 'presence')),
  studio_policy text NOT NULL CHECK (studio_policy IN ('provision', 'reuse-only')),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One template row per type; one override per (user, type). Two partial
-- indexes instead of NULLS NOT DISTINCT so the constraint reads explicitly.
CREATE UNIQUE INDEX thread_key_types_template_type
  ON public.thread_key_types (type) WHERE user_id IS NULL;
CREATE UNIQUE INDEX thread_key_types_user_type
  ON public.thread_key_types (user_id, type) WHERE user_id IS NOT NULL;

CREATE TRIGGER update_thread_key_types_updated_at
  BEFORE UPDATE ON public.thread_key_types
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.thread_key_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access to thread_key_types" ON public.thread_key_types
  USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

-- Shipped templates. v1 ROLLOUT SAFETY: only spec/thread are 'presence' —
-- they are the measured worktree spam (6 of the 20 most recent ephemeral
-- studios were pure discussions). issue/debug stay 'write' until
-- escalation-on-write detection ships (6e), then flip; a wrongly-presence
-- session that edits would otherwise mutate an unleased tree.
INSERT INTO public.thread_key_types (user_id, type, write_intent, studio_policy, description) VALUES
  (NULL, 'pr',     'write',    'provision',  'PR review/iteration — reviews check out the branch; checkout IS a write'),
  (NULL, 'branch', 'write',    'provision',  'Feature-branch coordination — authorship'),
  (NULL, 'task',   'write',    'provision',  'Task execution — runs and edits code'),
  (NULL, 'deploy', 'write',    'reuse-only', 'Deploys mutate state, but in an existing checkout'),
  (NULL, 'debug',  'write',    'reuse-only', 'Repros run code (= write), but rarely need a fresh worktree'),
  (NULL, 'issue',  'write',    'reuse-only', 'Discussions in practice, but may run repros; flips to presence when escalation ships'),
  (NULL, 'spec',   'presence', 'reuse-only', 'Design discussion; reads tolerate drift'),
  (NULL, 'thread', 'presence', 'reuse-only', 'General conversation');

-- Project slugs: the grammar's project recognition requires a registered
-- projects.slug, which never existed — cross-project prefixes (pcp:, inkread:)
-- have been convention only. Nullable; named explicitly, never auto-derived.
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS slug text
  CHECK (slug IS NULL OR slug ~ '^[a-z0-9][a-z0-9-]*$');
CREATE UNIQUE INDEX IF NOT EXISTS projects_user_slug
  ON public.projects (user_id, slug) WHERE slug IS NOT NULL;

COMMENT ON COLUMN public.projects.slug IS
  'Thread-key project prefix (grammar v2). Reserved against thread_key_types names at both write sites (application-enforced).';

-- Backfill ONLY the three slugs observed in live thread keys; the rest stay
-- NULL until named through save_project.
UPDATE public.projects SET slug = 'pcp'      WHERE slug IS NULL AND name = 'Personal Context Protocol';
UPDATE public.projects SET slug = 'inkread'  WHERE slug IS NULL AND name = 'inkread';
UPDATE public.projects SET slug = 'inktrade' WHERE slug IS NULL AND name = 'Inktrade';
