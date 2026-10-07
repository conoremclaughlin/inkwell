-- The backend processes the server launched, one row per launch, so a
-- restarted server can stop the ones still running from before it went down
-- (task 2562f0f8; packages/api/src/services/sessions/launched-processes.ts).
--
-- A restart signals only the server; the agent CLIs it started keep running.
-- The server writes a row before it spawns a process, sets the row's id in
-- the process's environment (INK_LAUNCH_ID), adds the pid once the process is
-- up, and stamps exited_at when the run settles. At startup it reads the rows
-- of its own instance with no exit and stops each process still running on
-- this boot: by pid and start time, or by its INK_LAUNCH_ID when the pid never
-- landed. A plain table: no function or trigger decides anything here.
CREATE TABLE public.launched_processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  backend text NOT NULL,
  -- NULL from the reservation until the process is up.
  pid integer CHECK (pid IS NULL OR pid > 0),
  -- Set when the process leads its own group, which is stopped as a whole.
  pgid integer CHECK (pgid IS NULL OR pgid > 0),
  -- `ps -o lstart=` at launch; NULL when it could not be read, and then the
  -- sweep reports the row instead of signalling a pid it cannot confirm.
  start_identity text,
  boot_id text NOT NULL,
  -- host:port of the server that launched it; a server sweeps only its own.
  server_instance text NOT NULL,
  launched_at timestamptz NOT NULL DEFAULT now(),
  exited_at timestamptz
);

CREATE INDEX launched_processes_open
  ON public.launched_processes (server_instance)
  WHERE exited_at IS NULL;

ALTER TABLE public.launched_processes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.launched_processes FROM anon, authenticated;
