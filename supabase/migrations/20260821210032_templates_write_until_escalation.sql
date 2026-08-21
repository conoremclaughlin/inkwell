-- 6b ROLLOUT SAFETY, made durable: every shipped template is write_intent
-- 'write' until escalation-on-write detection ships (Phase 6e). The live DB
-- was updated to this posture during PR #517; the 6a seed still said
-- 'presence' for spec/thread, so a rebuilt database would resurrect
-- presence WITHOUT the escalation net — a wrongly-presence session that
-- edits would mutate an unleased tree. Idempotent; 6e flips these back
-- together with the detection that makes presence safe.
UPDATE public.thread_key_types
SET write_intent = 'write'
WHERE user_id IS NULL AND write_intent = 'presence';
