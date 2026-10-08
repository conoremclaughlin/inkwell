-- Account deletion, fulfilled (ink://specs/account-deletion v5).
--
-- #755 recorded a person's request and nothing more. The deletion itself is
-- server code (services/account-deletion): close the account, revoke its
-- sign-in, drain its work, remove its files. This migration adds what that
-- code needs from the database, and one function: the rows are removed in a
-- single transaction (Conor, 2026-10-07: "I can see how deleting should be
-- done as a single transaction"). No triggers.
--
--   1. The request row carries the deletion's progress.
--   2. users.auth_uid: an account is resolved by its Supabase user, not by
--      email, so a request that outlives a deletion can never land on the
--      account of someone who signs up again with the same email.
--   3. A foreign key on each column that names an account and had none.
--   4. A message, or a thread, whose author's account was deleted keeps its
--      content and names no one: kind 'deleted_account'.
--   5. delete_account(p_user_id).
--
-- Each new key is added NOT VALID and then validated, which checks existing
-- rows under a SHARE UPDATE EXCLUSIVE lock. All eight columns held 0
-- dangling values when this was written.

-- 1. The request's progress ----------------------------------------------

ALTER TABLE public.account_deletion_requests
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS step text NOT NULL DEFAULT 'requested',
  ADD COLUMN IF NOT EXISTS auth_uid uuid,
  ADD COLUMN IF NOT EXISTS email_sha256 text,
  ADD COLUMN IF NOT EXISTS inventory jsonb,
  ADD COLUMN IF NOT EXISTS outcomes jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.account_deletion_requests
  ADD CONSTRAINT account_deletion_requests_step_known
    CHECK (step IN ('requested', 'closed', 'auth_revoked', 'drained', 'files_removed', 'rows_removed', 'completed')),
  ADD CONSTRAINT account_deletion_requests_closed_has_started
    CHECK ((step = 'requested') = (started_at IS NULL)),
  ADD CONSTRAINT account_deletion_requests_started_after_requested
    CHECK (started_at IS NULL OR started_at >= requested_at),
  ADD CONSTRAINT account_deletion_requests_completed_is_last
    CHECK ((step = 'completed') = (completed_at IS NOT NULL)),
  ADD CONSTRAINT account_deletion_requests_email_sha256_shape
    CHECK (email_sha256 IS NULL OR email_sha256 ~ '^[0-9a-f]{64}$');

-- 2. The Supabase user an account belongs to ------------------------------

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS auth_uid uuid;
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_uid_key
  ON public.users (auth_uid) WHERE auth_uid IS NOT NULL;

-- 3. A key on each column that names an account --------------------------

-- No rule: a message's sender is never cleared by a cascade. delete_account
-- turns the account's messages in other people's spaces into "Deleted
-- account" first; its own space's messages go with their threads.
ALTER TABLE public.inbox_thread_messages
  ADD CONSTRAINT inbox_thread_messages_sender_user_id_fkey
    FOREIGN KEY (sender_user_id) REFERENCES public.users(id) NOT VALID,
  ADD CONSTRAINT inbox_thread_messages_sender_sb_id_fkey
    FOREIGN KEY (sender_sb_id) REFERENCES public.agent_identities(id) NOT VALID;

-- No rule, like a message's sender: a thread's creator or closer is never
-- cleared by a cascade, which would break the principal checks below.
-- delete_account turns the account's threads in other people's spaces into
-- "Deleted account" first; its own space's threads go with the space.
ALTER TABLE public.inbox_threads
  ADD CONSTRAINT inbox_threads_created_by_user_id_fkey
    FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) NOT VALID,
  ADD CONSTRAINT inbox_threads_created_by_sb_id_fkey
    FOREIGN KEY (created_by_sb_id) REFERENCES public.agent_identities(id) NOT VALID,
  ADD CONSTRAINT inbox_threads_closed_by_user_id_fkey
    FOREIGN KEY (closed_by_user_id) REFERENCES public.users(id) NOT VALID,
  ADD CONSTRAINT inbox_threads_closed_by_sb_id_fkey
    FOREIGN KEY (closed_by_sb_id) REFERENCES public.agent_identities(id) NOT VALID;

ALTER TABLE public.heartbeat_notifications
  ADD CONSTRAINT heartbeat_notifications_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE NOT VALID;

-- No rule on purpose: an upload's row goes only with its bytes, through the
-- uploads helper, so the users row cannot be removed while one remains.
ALTER TABLE public.thread_uploads
  ADD CONSTRAINT thread_uploads_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;

ALTER TABLE public.inbox_thread_messages VALIDATE CONSTRAINT inbox_thread_messages_sender_user_id_fkey;
ALTER TABLE public.inbox_thread_messages VALIDATE CONSTRAINT inbox_thread_messages_sender_sb_id_fkey;
ALTER TABLE public.inbox_threads VALIDATE CONSTRAINT inbox_threads_created_by_user_id_fkey;
ALTER TABLE public.inbox_threads VALIDATE CONSTRAINT inbox_threads_created_by_sb_id_fkey;
ALTER TABLE public.inbox_threads VALIDATE CONSTRAINT inbox_threads_closed_by_user_id_fkey;
ALTER TABLE public.inbox_threads VALIDATE CONSTRAINT inbox_threads_closed_by_sb_id_fkey;
ALTER TABLE public.heartbeat_notifications VALIDATE CONSTRAINT heartbeat_notifications_user_id_fkey;
ALTER TABLE public.thread_uploads VALIDATE CONSTRAINT thread_uploads_user_id_fkey;

-- 4. "Deleted account" ---------------------------------------------------

ALTER TABLE public.inbox_thread_messages
  DROP CONSTRAINT inbox_thread_messages_sender_principal;
ALTER TABLE public.inbox_thread_messages
  ADD CONSTRAINT inbox_thread_messages_sender_principal CHECK (
    (sender_kind = 'sb' AND sender_sb_id IS NOT NULL AND sender_user_id IS NULL)
    OR (sender_kind = 'user' AND sender_user_id IS NOT NULL AND sender_sb_id IS NULL)
    OR (sender_kind = 'system' AND sender_sb_id IS NULL AND sender_user_id IS NULL)
    OR (sender_kind = 'deleted_account' AND sender_sb_id IS NULL AND sender_user_id IS NULL)
  ) NOT VALID;
ALTER TABLE public.inbox_thread_messages VALIDATE CONSTRAINT inbox_thread_messages_sender_principal;

-- A thread's creator and closer gain the same fourth kind.
ALTER TABLE public.inbox_threads DROP CONSTRAINT inbox_threads_creator_principal;
ALTER TABLE public.inbox_threads
  ADD CONSTRAINT inbox_threads_creator_principal CHECK (
    (created_by_kind = 'sb' AND created_by_sb_id IS NOT NULL AND created_by_user_id IS NULL)
    OR (created_by_kind = 'user' AND created_by_user_id IS NOT NULL AND created_by_sb_id IS NULL)
    OR (created_by_kind = 'system' AND created_by_sb_id IS NULL AND created_by_user_id IS NULL)
    OR (created_by_kind = 'deleted_account' AND created_by_sb_id IS NULL AND created_by_user_id IS NULL)
  ) NOT VALID;
ALTER TABLE public.inbox_threads VALIDATE CONSTRAINT inbox_threads_creator_principal;

ALTER TABLE public.inbox_threads DROP CONSTRAINT inbox_threads_closer_principal;
ALTER TABLE public.inbox_threads
  ADD CONSTRAINT inbox_threads_closer_principal CHECK ((
    (closed_at IS NULL AND closed_by_kind IS NULL AND closed_by_sb_id IS NULL AND closed_by_user_id IS NULL)
    OR (closed_at IS NOT NULL AND closed_by_kind IS NOT NULL AND (
      (closed_by_kind = 'sb' AND closed_by_sb_id IS NOT NULL AND closed_by_user_id IS NULL)
      OR (closed_by_kind = 'user' AND closed_by_user_id IS NOT NULL AND closed_by_sb_id IS NULL)
      OR (closed_by_kind = 'system' AND closed_by_sb_id IS NULL AND closed_by_user_id IS NULL)
      OR (closed_by_kind = 'deleted_account' AND closed_by_sb_id IS NULL AND closed_by_user_id IS NULL)
    ))
  ) IS TRUE) NOT VALID;
ALTER TABLE public.inbox_threads VALIDATE CONSTRAINT inbox_threads_closer_principal;

-- 5. delete_account -------------------------------------------------------
--
-- Removes an account's rows in one transaction, once the server code has
-- closed it, revoked its sign-in, drained its work and removed its files
-- (step files_removed). It moves the request to rows_removed in the same
-- transaction, so a restart after the commit resumes at the next step; run
-- again then, it is a no-op.
--
-- It holds no rule of its own beyond doing this in one transaction. Who may
-- be deleted is decided by the server code; the checks below repeat that
-- decision where the rows are, so nothing is removed if it changed.
--
-- The users row, then the account's identities, then its own spaces are
-- locked first, so an insert that names any of them (a message, a thread, a
-- membership) waits for this transaction and then fails its key check.

-- search_path is public, not empty: the identity and memory archive
-- triggers this delete fires name their history tables unqualified, and a
-- trigger runs under the search_path of the function that fired it.
CREATE OR REPLACE FUNCTION public.delete_account(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_step text;
  v_sb uuid[];
  v_ws uuid[];
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
BEGIN
  SELECT step INTO v_step
  FROM public.account_deletion_requests
  WHERE user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no deletion request for this account' USING ERRCODE = 'P0002';
  END IF;
  IF v_step IN ('rows_removed', 'completed') THEN
    RETURN jsonb_build_object('alreadyRemoved', true);
  END IF;
  IF v_step <> 'files_removed' THEN
    RAISE EXCEPTION 'the account''s files are not removed yet (step %)', v_step USING ERRCODE = 'P0001';
  END IF;

  -- This function writes rows_removed in the same transaction as the
  -- delete, so a users row already gone here was removed by something else.
  PERFORM 1 FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the account''s users row is gone, but its rows were never removed by this deletion'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(array_agg(id ORDER BY id), '{}'::uuid[]) INTO v_sb
  FROM (
    SELECT id FROM public.agent_identities WHERE user_id = p_user_id ORDER BY id FOR UPDATE
  ) locked;

  -- Its own spaces are locked before their members are checked: a join is a
  -- membership insert, whose key check on the space waits for this lock, and
  -- once the space is gone fails. So no one can join between the check and
  -- the delete.
  SELECT coalesce(array_agg(id ORDER BY id), '{}'::uuid[]) INTO v_ws
  FROM (
    SELECT id FROM public.workspaces WHERE user_id = p_user_id ORDER BY id FOR UPDATE
  ) locked_spaces;

  -- Who may be deleted, checked again where the rows are.
  IF EXISTS (
    SELECT 1 FROM public.agent_identities
    WHERE id = ANY (v_sb) AND coalesce(metadata ->> 'client', '') <> 'inkling-mobile'
  ) THEN
    RAISE EXCEPTION 'this account owns an identity that is not an inkling' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id = ANY (v_ws) AND m.user_id <> p_user_id
  ) THEN
    RAISE EXCEPTION 'this account owns a space with other members' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.task_gate_events
             WHERE actor_user_id = p_user_id OR assignee_user_id = p_user_id
                OR actor_identity_id = ANY (v_sb) OR assignee_identity_id = ANY (v_sb))
     OR EXISTS (SELECT 1 FROM public.task_graph_revisions
                WHERE actor_user_id = p_user_id OR actor_identity_id = ANY (v_sb))
     OR EXISTS (SELECT 1 FROM public.publication_operations
                WHERE authorizer_user_id = p_user_id
                   OR authorizer_identity_id = ANY (v_sb) OR executor_identity_id = ANY (v_sb))
     OR EXISTS (SELECT 1 FROM public.publication_operation_events
                WHERE actor_user_id = p_user_id OR actor_identity_id = ANY (v_sb))
     OR EXISTS (SELECT 1 FROM public.skills
                WHERE author_user_id = p_user_id OR last_published_by = p_user_id OR deprecated_by = p_user_id)
     OR EXISTS (SELECT 1 FROM public.skill_versions WHERE published_by = p_user_id)
  THEN
    RAISE EXCEPTION 'operator records name this account' USING ERRCODE = 'P0001';
  END IF;
  -- The person's own self-serve awakening is theirs to remove; any other
  -- kindle record involves another account.
  IF EXISTS (
    SELECT 1 FROM public.kindle_lineage
    WHERE (parent_user_id = p_user_id OR child_user_id = p_user_id OR facilitator_user_id = p_user_id)
      AND NOT (facilitator_user_id = p_user_id AND child_user_id = p_user_id AND parent_user_id IS NULL)
  ) OR EXISTS (
    SELECT 1 FROM public.kindle_tokens
    WHERE (creator_user_id = p_user_id OR used_by_user_id = p_user_id)
      AND NOT (creator_user_id = p_user_id AND creator_agent_id IS NULL
               AND (used_by_user_id IS NULL OR used_by_user_id = p_user_id))
  ) THEN
    RAISE EXCEPTION 'a kindle record links this account with another' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.thread_uploads WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'the account still has uploads; remove them first' USING ERRCODE = 'P0001';
  END IF;

  -- "Deleted account": what the account and its inklings wrote in spaces it
  -- doesn't own stays, with nothing that names them. The pcp metadata block
  -- carries the sender's ids, so it goes too.
  UPDATE public.inbox_thread_messages m
  SET sender_kind = 'deleted_account',
      sender_user_id = NULL,
      sender_sb_id = NULL,
      sender_agent_id = NULL,
      metadata = coalesce(m.metadata, '{}'::jsonb) - 'pcp'
  FROM public.inbox_threads t
  WHERE t.id = m.thread_id
    AND NOT (t.workspace_id = ANY (v_ws))
    AND (m.sender_user_id = p_user_id OR m.sender_sb_id = ANY (v_sb));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('messagesFromDeletedAccount', v_n);

  -- The threads it started or closed there keep their history the same way.
  UPDATE public.inbox_threads t
  SET created_by_kind = 'deleted_account', created_by_user_id = NULL, created_by_sb_id = NULL
  WHERE NOT (t.workspace_id = ANY (v_ws))
    AND (t.created_by_user_id = p_user_id OR t.created_by_sb_id = ANY (v_sb));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('threadsStartedByDeletedAccount', v_n);
  UPDATE public.inbox_threads t
  SET closed_by_kind = 'deleted_account', closed_by_user_id = NULL, closed_by_sb_id = NULL
  WHERE NOT (t.workspace_id = ANY (v_ws))
    AND (t.closed_by_user_id = p_user_id OR t.closed_by_sb_id = ANY (v_sb));

  DELETE FROM public.inbox_thread_participants WHERE sb_id = ANY (v_sb);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('identityParticipants', v_n);

  DELETE FROM public.agent_inbox WHERE sender_user_id = p_user_id OR sender_sb_id = ANY (v_sb);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('legacyInboxSent', v_n);

  DELETE FROM public.task_comments
  WHERE user_id = p_user_id OR created_by_sb_id = ANY (v_sb) OR workspace_id = ANY (v_ws);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('taskComments', v_n);

  DELETE FROM public.task_group_comments WHERE user_id = p_user_id OR created_by_sb_id = ANY (v_sb);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('taskGroupComments', v_n);

  DELETE FROM public.kindle_lineage
  WHERE facilitator_user_id = p_user_id AND child_user_id = p_user_id AND parent_user_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('kindleLineage', v_n);

  DELETE FROM public.kindle_tokens WHERE creator_user_id = p_user_id AND creator_agent_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('kindleTokens', v_n);

  DELETE FROM public.artifacts WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('artifacts', v_n);

  DELETE FROM public.user_permissions WHERE user_id = p_user_id;
  DELETE FROM public.trusted_users WHERE user_id = p_user_id;

  -- In other people's records the account is no longer named. audit_log
  -- rows are kept for security review, without the account's id.
  UPDATE public.audit_log SET user_id = NULL WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('auditRowsKept', v_n);
  UPDATE public.artifact_history SET changed_by_user_id = NULL WHERE changed_by_user_id = p_user_id;
  UPDATE public.authorized_groups SET authorized_by = NULL WHERE authorized_by = p_user_id;
  UPDATE public.authorized_groups SET revoked_by = NULL WHERE revoked_by = p_user_id;
  UPDATE public.group_challenge_codes SET created_by = NULL WHERE created_by = p_user_id;
  UPDATE public.tasks SET assignee_user_id = NULL WHERE assignee_user_id = p_user_id;
  UPDATE public.tasks SET assignee_identity_id = NULL WHERE assignee_identity_id = ANY (v_sb);
  UPDATE public.trusted_users SET added_by = NULL WHERE added_by = p_user_id;
  UPDATE public.user_permissions SET granted_by = NULL WHERE granted_by = p_user_id;
  UPDATE public.scheduled_reminders SET sb_id = NULL WHERE sb_id = ANY (v_sb) AND user_id <> p_user_id;

  -- The account's own conversations and reminders go before its identities:
  -- they name them by keys with no delete rule, and the users row's cascade
  -- (which would take them too) comes only after.
  DELETE FROM public.inbox_threads WHERE workspace_id = ANY (v_ws);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('ownThreads', v_n);
  DELETE FROM public.scheduled_reminders WHERE user_id = p_user_id;

  -- Memories and identities archive themselves on delete, so they go before
  -- the users row, and their history after them.
  DELETE FROM public.memories WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('memories', v_n);
  DELETE FROM public.memory_history WHERE user_id = p_user_id;

  DELETE FROM public.agent_identities WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('identities', v_n);
  DELETE FROM public.agent_identity_history WHERE user_id = p_user_id;

  -- The users row, and with it every cascade: the personal space and what
  -- is in it, sessions, reminders, tokens, contacts and the rest.
  DELETE FROM public.users WHERE id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('users', v_n);

  UPDATE public.account_deletion_requests SET step = 'rows_removed' WHERE user_id = p_user_id;
  RETURN v_counts;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_account(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_account(uuid) TO service_role;
