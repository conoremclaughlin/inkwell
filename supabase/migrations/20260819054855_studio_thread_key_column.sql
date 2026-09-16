-- Promote the overflow studio's threadKey from metadata JSONB to a column.
--
-- `listEphemeralByThread` filtered on `metadata->>'threadKey'` with no index
-- supporting it, so closing a thread sequentially scanned `studios`. The
-- neighbouring lease fields already earned expression indexes
-- (`studios_lease_thread_idx`), which is the same recognition arrived at
-- halfway: this is a routing key, not incidental metadata.
--
-- A real column beats an expression index here because the value is also a
-- correctness predicate — `matchesOverflow` refuses to reuse a studio whose
-- threadKey differs, and teardown fences on it. Those reads should not depend
-- on a JSONB path that nothing constrains.

ALTER TABLE public.studios ADD COLUMN IF NOT EXISTS thread_key text;

COMMENT ON COLUMN public.studios.thread_key IS
  'Thread this studio was provisioned for. Set on ephemeral overflow studios; NULL for durable studios. Authoritative over the legacy metadata->>threadKey.';

-- Backfill every existing overflow studio (34 rows at time of writing) so the
-- column is authoritative for all rows and readers never need a fallback.
UPDATE public.studios
   SET thread_key = metadata->>'threadKey'
 WHERE thread_key IS NULL
   AND metadata ? 'threadKey';

-- Partial: only overflow studios carry a thread_key, and every lookup is
-- user-scoped.
CREATE INDEX IF NOT EXISTS studios_thread_key_idx
    ON public.studios (user_id, thread_key)
 WHERE thread_key IS NOT NULL;
