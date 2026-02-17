-- Temporary backward-compatibility shim after renaming public.workspaces -> public.studios.
-- Some running API processes still query public.workspaces during rolling deploys.
-- This updatable view keeps those reads/writes working until all servers are on studio-first code.

DO $$
BEGIN
  IF to_regclass('public.studios') IS NOT NULL
     AND to_regclass('public.workspaces') IS NULL THEN
    EXECUTE 'CREATE VIEW public.workspaces AS SELECT * FROM public.studios';
  END IF;
END $$;

COMMENT ON VIEW public.workspaces IS 'Backward-compatibility view over public.studios. Remove after all code paths stop referencing workspaces.';
