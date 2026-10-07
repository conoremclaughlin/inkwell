-- Photos and documents a person sends into a thread (upload design r2–r4).
--
-- thread_uploads holds one row per uploaded file. The bytes live under the
-- server's private uploads root, never in the database, at a path built
-- only from this row's ids. The route inserts the row before writing a
-- byte, so the row's slots (below) are the quota for staging as well as for
-- stored files.
--
-- thread_upload_claims is how a send takes its uploads. One send is
-- (thread_id, client_message_id); its claim set is one row per upload,
-- numbered by position in the sorted manifest, each carrying the same
-- author, content digest and manifest digest. The route inserts the whole
-- set as one statement, so it lands whole or not at all. A claim row is
-- never deleted while its upload lives and never moves back; it only gains
-- message_id (confirmed) or a held reason (no matching message yet).
--
-- Three guarantees come from constraints alone, with no function or
-- trigger:
--
-- 1. One manifest per send. UNIQUE (thread_id, client_message_id,
--    manifest_index): every non-empty set has a row at index 0, so a second
--    set under the same send collides there and claims nothing.
-- 2. No claim on an upload the orphan sweep has closed, and no close of an
--    upload that is claimed. The claim's foreign key names the upload's
--    claim_gate, which it pins to 'open'. A claim and a sweep closing the
--    gate wait on the same row lock: whichever commits first wins, and the
--    other fails with 23503. A still-receiving upload cannot be claimed.
-- 3. A claim is only ever for the upload's own person and thread: both are
--    part of the same foreign key.
--
-- Quotas are slots. Each row holds one of 50 account slots, one of 20
-- pending slots until it is claimed, and one of 1024 global slots, each
-- under a partial unique index over every row whose bytes may still exist.
-- Two uploads racing for one slot cannot both win, and nothing can drift.
-- At the 10 MiB cap that is 500 MiB per account and 10 GiB in total.
--
-- Removal keeps the slots until the bytes are confirmed gone: a row moves
-- live -> removing (reads refuse from here; end_reason says why) ->
-- removed (the API confirmed the file and any staging file are absent).
-- A failed unlink or a crash leaves the row removing, still holding its
-- slots, for the next pass to retry; only removed frees capacity.
--
-- created_at has no default on purpose: the API writes it from its own
-- clock, the same clock it later compares against (the pending-orphan hour,
-- the reconciler's minimum age, any retention). The database container's
-- clock stops while the host sleeps, so a stamp from it can be minutes or
-- hours behind the moment the API acted.
--
-- No foreign keys to users, workspaces or inbox_threads, on purpose: a
-- cascade would delete the rows that say which bytes to remove and leave
-- the bytes behind. Removal goes through the API, which ends the row first
-- and then unlinks.
--
-- Plain tables only. Row level security is on with no policies, so only the
-- service role the API uses can read or write them.

CREATE TABLE IF NOT EXISTS public.thread_uploads (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'document')),
  content_type text NOT NULL CHECK (
    content_type IN ('image/jpeg', 'image/png', 'application/pdf', 'text/plain; charset=utf-8')
  ),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'removing', 'removed')),
  end_reason text CHECK (end_reason IN ('orphan', 'expired', 'account_deleted', 'manual')),
  claim_gate text NOT NULL DEFAULT 'receiving'
    CHECK (claim_gate IN ('receiving', 'open', 'closed')),
  account_slot smallint NOT NULL CHECK (account_slot BETWEEN 0 AND 49),
  pending_slot smallint CHECK (pending_slot BETWEEN 0 AND 19),
  global_slot smallint NOT NULL CHECK (global_slot BETWEEN 0 AND 1023),
  damaged_at timestamptz,
  created_at timestamptz NOT NULL,
  ended_at timestamptz,
  removed_at timestamptz,
  CONSTRAINT thread_uploads_ended_with_reason CHECK ((state = 'live') = (end_reason IS NULL)),
  CONSTRAINT thread_uploads_ended_with_time CHECK ((state = 'live') = (ended_at IS NULL)),
  CONSTRAINT thread_uploads_removed_with_time CHECK ((state = 'removed') = (removed_at IS NOT NULL)),
  -- The claim fence's target: unique because id is.
  CONSTRAINT thread_uploads_claim_key UNIQUE (id, claim_gate, user_id, thread_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS thread_uploads_account_slot_key
  ON public.thread_uploads (user_id, account_slot) WHERE state <> 'removed';

CREATE UNIQUE INDEX IF NOT EXISTS thread_uploads_pending_slot_key
  ON public.thread_uploads (user_id, pending_slot)
  WHERE state <> 'removed' AND pending_slot IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS thread_uploads_global_slot_key
  ON public.thread_uploads (global_slot) WHERE state <> 'removed';

-- The orphan sweep: live rows, oldest first.
CREATE INDEX IF NOT EXISTS thread_uploads_live_created_idx
  ON public.thread_uploads (created_at) WHERE state = 'live';

-- Removals still to finish, oldest first.
CREATE INDEX IF NOT EXISTS thread_uploads_removing_idx
  ON public.thread_uploads (ended_at) WHERE state = 'removing';

CREATE TABLE IF NOT EXISTS public.thread_upload_claims (
  upload_id uuid PRIMARY KEY,
  claim_gate text NOT NULL DEFAULT 'open' CHECK (claim_gate = 'open'),
  user_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  client_message_id uuid NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_index smallint NOT NULL CHECK (manifest_index BETWEEN 0 AND 3),
  message_id uuid,
  held_reason text CHECK (held_reason IN ('not_found', 'mismatch')),
  held_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT thread_upload_claims_held_together CHECK ((held_reason IS NULL) = (held_at IS NULL)),
  CONSTRAINT thread_upload_claims_confirmed_not_held
    CHECK (message_id IS NULL OR held_reason IS NULL),
  CONSTRAINT thread_upload_claims_send_key UNIQUE (thread_id, client_message_id, manifest_index),
  CONSTRAINT thread_upload_claims_upload_fkey FOREIGN KEY (upload_id, claim_gate, user_id, thread_id)
    REFERENCES public.thread_uploads (id, claim_gate, user_id, thread_id)
);

-- The reconciler's queue: claims with no confirmed message, oldest first.
CREATE INDEX IF NOT EXISTS thread_upload_claims_unconfirmed_idx
  ON public.thread_upload_claims (created_at) WHERE message_id IS NULL;

ALTER TABLE public.thread_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thread_upload_claims ENABLE ROW LEVEL SECURITY;
