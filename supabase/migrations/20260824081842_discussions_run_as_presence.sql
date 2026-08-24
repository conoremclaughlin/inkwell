-- Discussions EXECUTE — they do not queue behind the studio lock.
--
-- The all-write pin (20260821210032) made discussion threads contend for
-- the write lock, and #523's reuse-only wiring then HELD them whenever the
-- studio was busy. That was never the ruling: discussions are supposed to
-- run in the existing studio, tolerating drift, with no lock and no
-- worktree — the SB opts into a studio explicitly when one is needed.
-- (Conor, 2026-08-24: "They were supposed to still allow execution, which
-- is the case today.")
--
-- presence = bind to the studio without the lock, run immediately.
-- reuse-only still means what it always meant: never auto-build a worktree.
--
-- The escalation-on-write net (6e) has not shipped; running discussions
-- unlocked is a CONSCIOUS acceptance of that risk, directed by Conor.
-- deploy stays write + reuse-only: it mutates state and must hold when the
-- tree is locked.
UPDATE public.thread_key_types
SET write_intent = 'presence'
WHERE user_id IS NULL AND type IN ('thread', 'spec', 'issue', 'debug');

-- Descriptions are user-facing (list_thread_key_types) — keep them telling
-- the truth about the flipped behavior.
UPDATE public.thread_key_types SET description = 'General conversation — runs without the lock, tolerates drift'
WHERE user_id IS NULL AND type = 'thread';
UPDATE public.thread_key_types SET description = 'Design discussion — runs without the lock, tolerates drift'
WHERE user_id IS NULL AND type = 'spec';
UPDATE public.thread_key_types SET description = 'Issue triage/discussion — runs without the lock; check out a studio explicitly for heavy repros'
WHERE user_id IS NULL AND type = 'issue';
UPDATE public.thread_key_types SET description = 'Collaborative debugging — runs without the lock; check out a studio explicitly for heavy repros'
WHERE user_id IS NULL AND type = 'debug';
