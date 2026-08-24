-- "When did this last work?" is at its most useful during an outage. Reporting
-- the outage must not be the thing that destroys the answer.
--
-- update_integration_health used to preserve last_healthy_at in the application:
-- read the stored value, then write it back inside the upsert. Two statements,
-- so two ways to lose it. A healthy report landing between the read and the
-- write was silently reverted to the older timestamp, and a failed read became
-- null, erasing the history outright on a transient error.
--
-- The invariant belongs in the write itself, where it is atomic and where it
-- holds for every writer rather than only for the ones that remember to.
--
--   healthy  -> stamp it
--   anything else -> keep whatever is stored (nothing, on a first report)
--
-- Deliberate consequence: last_healthy_at can no longer be cleared or backdated
-- by an ordinary write. That is the point. Clearing it requires disabling this
-- trigger explicitly.

CREATE OR REPLACE FUNCTION public.integration_health_retain_last_healthy_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'healthy' THEN
    NEW.last_healthy_at := COALESCE(NEW.last_healthy_at, now());
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.last_healthy_at := OLD.last_healthy_at;
  ELSE
    -- First report for this service, and it is not healthy: there is no prior
    -- value to keep, and it has never been observed working.
    NEW.last_healthy_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS integration_health_retain_last_healthy_at ON public.integration_health;

CREATE TRIGGER integration_health_retain_last_healthy_at
  BEFORE INSERT OR UPDATE ON public.integration_health
  FOR EACH ROW
  EXECUTE FUNCTION public.integration_health_retain_last_healthy_at();
