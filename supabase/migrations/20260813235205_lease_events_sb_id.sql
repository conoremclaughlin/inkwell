-- Canonical identity references on lease events (PR #492 review, Lumen P2).
--
-- Persisted agent references must use the identity UUID (agent_identities.id),
-- never the slug — slugs are ambiguous across workspaces. agent_id stays as
-- the display slug, resolved at the boundary; sb_id is the authoritative
-- reference. The live lease jsonb carries the same sbId field.

ALTER TABLE public.studio_lease_events
  ADD COLUMN IF NOT EXISTS sb_id uuid REFERENCES public.agent_identities (id) ON DELETE SET NULL;
