-- A refresh record bound to an SB goes when that SB goes (task 3f7f6a8f, PR #795).
--
-- mcp_tokens.sb_id was ON DELETE SET NULL. Deleting a space cascades its SBs'
-- identity rows away, and SET NULL left each SB's refresh record holding only
-- its slug, which went on minting slug-only access tokens for up to 90 days,
-- and again whenever the owner had or later made an SB of the same slug.
-- With CASCADE the record is deleted with the identity, so nothing mints after
-- a deletion. Identity rows are deleted only by cascade, from a deleted space
-- (DELETE /api/admin/workspaces/:workspaceId) or a deleted account (the
-- account-deletion fulfilment, whose users delete already takes the records
-- through mcp_tokens_user_id_fkey).
--
-- Records a past deletion already nulled are left as they are. Counted
-- read-only on 2026-10-08: none (all 558 records name no SB).

ALTER TABLE public.mcp_tokens DROP CONSTRAINT IF EXISTS mcp_tokens_sb_id_fkey;

ALTER TABLE public.mcp_tokens
  ADD CONSTRAINT mcp_tokens_sb_id_fkey
  FOREIGN KEY (sb_id) REFERENCES public.agent_identities (id) ON DELETE CASCADE;
