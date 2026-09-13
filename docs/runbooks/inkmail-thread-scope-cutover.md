# Inkmail thread-scope cutover — operator runbook

Spec: `ink://specs/inkmail-thread-scope` (§4 rollout, §4a preflights, §4b PR sequence).
Migrations: `20260913081634_inkmail_cutover_manifests.sql` (staging + preflight) and
`20260913090000_inkmail_thread_scope_cutover.sql` (the cutover).

One transaction, writers stopped. Nothing in the migration infers where a
thread belongs or who wrote a row: threads and rows take what the operator
attests, and anything unattested or contradicted aborts with row ids.

## What the manifests are

Two tables, loaded before the cutover runs, kept **outside git** as CSV
(they carry user UUIDs):

| table                                    | one row per         | columns                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inkmail_cutover_thread_attestations`    | thread              | `thread_id`, `workspace_id`, `attested_by`, `note`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `inkmail_cutover_principal_attestations` | legacy row or batch | `scope` (`message` \| `participant` \| `read_status` \| `creator` \| `closer`), `thread_id`, `legacy_id` (the slug the legacy column holds), `row_id` (a message id; NULL = the whole `(thread, scope, legacy_id)` batch), `kind` (`sb` \| `user` \| `system`), `sb_id` or `sb_agent_id` (an SB by id, or by slug resolved in the thread's attested workspace — exactly one identity there, owned by a member), `user_id` (a workspace member), `attested_by`, `note` |

A row-level attestation wins over its batch. Every thread needs a workspace
row. Every message, participant, read pointer and creator needs an
attestation; a closer only where `closed_at` is set (an open thread has no
closer, and attesting one aborts).

## Before the window (any time; read-only)

1. Apply `20260913081634` (staging + preflight). It changes no live table.
2. Draft the manifests from the suggestion functions and review them by hand:

   ```sql
   \copy (SELECT * FROM public.inkmail_cutover_suggest_threads())    TO 'threads.csv'    CSV HEADER
   \copy (SELECT * FROM public.inkmail_cutover_suggest_principals()) TO 'principals.csv' CSV HEADER
   ```

   A suggestion is the reviewer's hint column: the owner's personal
   workspace when the owner is in exactly one workspace; the single identity
   a slug resolves to; the owner for `unknown` rows carrying the human marker;
   `system` for the system sender. **It attests nothing** — the migration never
   reads it. The reviewed manifests are what you load.

3. Load the reviewed manifests:

   ```sql
   \copy public.inkmail_cutover_thread_attestations (thread_id, workspace_id, attested_by, note) FROM 'threads-attested.csv' CSV HEADER
   \copy public.inkmail_cutover_principal_attestations (scope, thread_id, legacy_id, row_id, kind, sb_id, sb_agent_id, user_id, attested_by, note) FROM 'principals-attested.csv' CSV HEADER
   ```

4. Run the preflight until it is empty:

   ```sql
   SELECT * FROM public.inkmail_cutover_preflight() ORDER BY check_name, thread_id;
   ```

   Every row is something the cutover would abort on. `check_name` values:
   `user_without_personal_workspace` (the cutover provisions missing ones; several is yours to resolve),
   `thread_unattested`, `thread_attestation_orphan`, `thread_workspace_missing`, `thread_owner_not_member`,
   `thread_participant_slug_unresolved`, `thread_key_duplicate`, `identity_slug_collision`,
   `principal_unattested`, `principal_attestation_orphan`, `closer_attested_on_open_thread`,
   `principal_attestation_unresolved`, `participant_user_attested_with_session`,
   `principal_duplicate_after_mapping`.

5. Rehearse on a snapshot: restore a production snapshot to an isolated
   database, load the same manifests, run the cutover there, read every abort
   you can provoke. CI runs the synthetic version of this on every push
   (`integration-db-cutover-rehearsal`: the stack comes up at the pre-cutover
   schema and `packages/api/src/data/cutover/thread-scope-cutover.integration.test.ts`
   executes the migration file per fixture inside a rolled-back transaction).

## The window

1. **Stop every writer**: the main server, any worktree server, the channel
   plugins riding on them. Hold auto-restart. The new binary is already built
   and its tests have passed.
2. **Snapshot** the database.
3. **Apply** `20260913090000` with `supabase db push` — one transaction per
   migration file. It runs the preflight first and aborts with the first 50
   findings if anything is left; an abort leaves the pre-cutover schema
   intact and the old binary can start against it.
4. **Regenerate types**, **deploy** the new binary, **start** the server, run
   the whole-path checks of spec §4b.

Post-commit failure (the new binary does not start) is decided before the
window: forward-fix while stopped by default; restore from the snapshot as
the fallback. The old binary cannot run against the dropped columns.

## What the cutover does, in order

0. Provisions a personal workspace (and owner membership) for every user
   without one — a per-user fact, not a thread attribution.
1. Preflight; abort on any finding.
2. Adds `workspace_id` and the principal columns; drops `created_by_agent_id`'s NOT NULL.
3. Threads → attested workspaces; participants inherit.
4. Principals from attestations: messages (row over batch), participants,
   read pointers, creators, closers where closed.
5. Namespace move: `projects`, `project_slug_aliases`, `thread_key_types` get
   `workspace_id` (projects → the owner's personal workspace; `thread_key_types.user_id`
   is dropped, NULL workspace = global template); `compute_thread_key_pin(p_workspace_id, key)`;
   every thread re-pinned under its workspace (count reported as a NOTICE).
6. Constraints: NOT NULLs; creator CHECK (unconditional), closer CHECK
   (conditional on `closed_at`), sender CHECK (system = both ids null, no slug);
   `UNIQUE (workspace_id, thread_key)`; `UNIQUE (id, workspace_id)` on threads and
   identities; `UNIQUE (workspace_id, agent_id)` on identities; participants'
   composite FKs `(thread_id, workspace_id)` and `(sb_id, workspace_id)`;
   `UNIQUE (thread_id, principal_key)` on participants and read pointers.
7. SQL rewritten for the new columns: `get_unread_thread_candidates(p_sb_id, …)`,
   `advance_thread_read_pointer(p_thread_id, p_sb_id, p_user_id, …)`,
   `stamp_routing_hold` / `clear_routing_hold` (`p_workspace_id`),
   `claim_turn_epoch` (closed-thread regrant refusal via the studio owner's workspaces),
   `reopen_inbox_thread(p_thread_id, p_actor_sb_id, p_actor_user_id)`.
8. Drops `inbox_threads.user_id`, `created_by_agent_id`, `closed_by_agent_id`,
   `inbox_thread_participants.agent_id`, `inbox_thread_read_status.agent_id`.
   `inbox_thread_messages.sender_agent_id` stays as a display slug for SB rows only.
9. `AFTER INSERT ON users` provisions the personal workspace in the database.
10. Drops the staging tables and helpers.
