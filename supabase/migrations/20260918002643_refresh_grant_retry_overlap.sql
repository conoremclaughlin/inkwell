-- A rotated refresh grant keeps ONE generation of its history, so a client that
-- retried — or lost a concurrent exchange — can still be answered.
--
-- Rotation replaces the grant's secret. Until now the replaced value vanished,
-- so anyone presenting it was refused: the loser of a race between two
-- processes sharing a grant, and equally a client whose successful response was
-- lost in transit and which retried the only token it still had. Both were told
-- to re-authenticate while the grant itself was alive and its live secret sat
-- in someone else's hands.
--
-- `previous_refresh_token` is the value the current secret replaced, and
-- `rotated_at` is when that happened. Within a bounded overlap — see
-- REFRESH_RETRY_OVERLAP_SECONDS in packages/api/src/auth/refresh-policy.ts —
-- presenting it returns the committed successor rather than a refusal, and
-- rotates nothing, so any number of retries converge on the one live secret.
--
-- Deliberately ONE generation and not a chain. Every generation kept is another
-- window in which a stolen secret is still redeemable, and the case this exists
-- for — a retry, or two processes racing over the same file — is satisfied by
-- the immediately-previous value.
--
-- Keeping it also makes reuse of a just-rotated secret *visible* for the first
-- time: past the window the server can now tell a replay from an unknown token
-- and says so in the log. It does not revoke the grant on that signal; breach
-- detection (RFC 9700 §4.14.2) is a separate, unmade policy decision.

ALTER TABLE mcp_tokens
  ADD COLUMN IF NOT EXISTS previous_refresh_token text,
  ADD COLUMN IF NOT EXISTS rotated_at timestamp with time zone;

-- Looked up by exact value on every exchange that misses on refresh_token.
-- Partial, because only a rotated row carries one. UNIQUE so that lookup can
-- use `.single()` and be sure of it: a previous value was itself a
-- refresh_token, which is already unique, so this constraint costs nothing and
-- removes the possibility of an ambiguous match.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_tokens_previous_refresh_token
  ON public.mcp_tokens USING btree (previous_refresh_token)
  WHERE previous_refresh_token IS NOT NULL;
