-- Session aliases become studio-scoped.
--
-- Aliases were unique per (user_id, agent_id) among active sessions, which
-- made "review" a single global name in an agent's namespace. With several
-- studios per agent that is the wrong shape twice over:
--
--   1. Two studios cannot both hold a session named "review" — the second
--      insert violates the unique index, so the natural name is unavailable
--      to every studio but the first.
--   2. Resolving a bare alias picked the most recently started match
--      (ORDER BY started_at DESC LIMIT 1). An alias that silently resolves to
--      a session in a different worktree is the same class of defect as the
--      cross-repo misroute in spec:trigger-studio-routing — the caller asked
--      for a place and got somewhere else.
--
-- The new scope is (user_id, agent_id, studio_id, alias). Sessions with no
-- studio share one bucket via COALESCE against the nil UUID: a plain unique
-- index would treat every NULL studio_id as distinct and let unlimited
-- unstudioed sessions claim the same alias, which is exactly the ambiguity
-- this migration exists to remove. (NULLS NOT DISTINCT would also work on
-- PG15+; COALESCE is version-independent and states the intent inline.)
--
-- This constraint is strictly weaker than the one it replaces, so every
-- existing row already satisfies it — no backfill, no conflict window.
--
-- Ambiguity is now resolved in the repository rather than by the index:
-- findByAlias refuses a bare alias that matches sessions in more than one
-- studio instead of guessing. See session-repository.ts (AmbiguousAliasError).

DROP INDEX IF EXISTS idx_sessions_alias_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_alias_unique
  ON sessions (
    user_id,
    agent_id,
    COALESCE(studio_id, '00000000-0000-0000-0000-000000000000'::uuid),
    alias
  )
  WHERE ended_at IS NULL AND alias IS NOT NULL;

-- Lookup index for routing queries. Narrowed to alias IS NOT NULL so it only
-- covers rows the alias resolver can actually match.
DROP INDEX IF EXISTS idx_sessions_alias_lookup;

CREATE INDEX IF NOT EXISTS idx_sessions_alias_lookup
  ON sessions (user_id, agent_id, alias)
  WHERE ended_at IS NULL AND alias IS NOT NULL;

COMMENT ON INDEX idx_sessions_alias_unique IS
  'One active session per alias per (user, agent, studio). Unstudioed sessions share the nil-UUID bucket.';
