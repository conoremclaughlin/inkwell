-- A person's request to delete their account (App Store Review Guideline
-- 5.1.1(v): an app that lets people create an account must let them start
-- deleting it from inside the app).
--
-- POST /api/admin/account/deletion records one row per account, and only
-- records it. Fulfilling the request (what is deleted, how long it takes and
-- how the person is told it is done) is a separate, reviewed step that sets
-- completed_at; it is not in this migration.
--
-- user_id has no foreign key on purpose, so the row can outlive the users row
-- it names. The row holds no email, but a stable account id with its request
-- and completion times is still linkable account metadata: how long it is
-- kept after completion needs a retention decision before this ships.
--
-- Plain table only: no function, trigger or policy. Row level security is on
-- with no policies, so only the service role the API uses can read or write
-- it, like this schema's other server-only tables.

CREATE TABLE IF NOT EXISTS public.account_deletion_requests (
  user_id uuid PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT account_deletion_requests_completed_after_requested
    CHECK (completed_at IS NULL OR completed_at >= requested_at)
);

-- The deletion step's queue: requests still waiting, oldest first.
CREATE INDEX IF NOT EXISTS account_deletion_requests_pending_idx
  ON public.account_deletion_requests (requested_at)
  WHERE completed_at IS NULL;

ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;
