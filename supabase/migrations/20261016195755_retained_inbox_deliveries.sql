-- Per-source delivery ownership, separate from reader cursors and native
-- transcripts. This schema does not enable intake, replay, or recovery.
-- Source/session/launch deletion is refused while referenced: cleanup must
-- explicitly reconcile these obligations rather than silently discard them.
CREATE TABLE public.sb_inbox_deliveries (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  recipient_id uuid NOT NULL REFERENCES public.agent_identities(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE RESTRICT,
  thread_message_id uuid REFERENCES public.inbox_thread_messages(id) ON DELETE RESTRICT,
  inbox_message_id uuid REFERENCES public.agent_inbox(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'bound', 'held', 'settled')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  launch_id uuid REFERENCES public.launched_processes(id) ON DELETE RESTRICT,
  turn_epoch uuid,
  native_session_id text,
  native_input_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK ((thread_message_id IS NULL) <> (inbox_message_id IS NULL)),
  CHECK (
    (state = 'pending' AND launch_id IS NULL AND turn_epoch IS NULL)
    OR (state <> 'pending' AND launch_id IS NOT NULL AND turn_epoch IS NOT NULL)
  ),
  CHECK ((native_session_id IS NULL) = (native_input_id IS NULL)),
  CHECK (native_session_id IS NULL OR length(native_session_id) BETWEEN 1 AND 256),
  CHECK (state <> 'pending' OR native_session_id IS NULL),
  CHECK ((state = 'settled') = (settled_at IS NOT NULL))
);

-- One obligation per original source and canonical recipient, including
-- settled rows. A new epoch is not permission to deliver the source again.
CREATE UNIQUE INDEX sb_inbox_deliveries_thread_source
  ON public.sb_inbox_deliveries (recipient_id, thread_message_id)
  WHERE thread_message_id IS NOT NULL;
CREATE UNIQUE INDEX sb_inbox_deliveries_legacy_source
  ON public.sb_inbox_deliveries (recipient_id, inbox_message_id)
  WHERE inbox_message_id IS NOT NULL;
CREATE INDEX sb_inbox_deliveries_unsettled
  ON public.sb_inbox_deliveries (owner_id, recipient_id, session_id, id)
  WHERE state <> 'settled';
CREATE INDEX sb_inbox_deliveries_launch
  ON public.sb_inbox_deliveries (launch_id)
  WHERE state <> 'settled';

ALTER TABLE public.sb_inbox_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sb_inbox_deliveries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sb_inbox_deliveries TO service_role;
