-- Track whether invited users have actually logged in.
-- Null last_login_at means invited/placeholder account that has not completed auth yet.

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- Backfill for existing users that already have a Supabase auth account.
UPDATE public.users AS u
SET last_login_at = COALESCE(au.last_sign_in_at, au.created_at)
FROM auth.users AS au
WHERE u.last_login_at IS NULL
  AND u.email IS NOT NULL
  AND lower(au.email) = lower(u.email);

COMMENT ON COLUMN public.users.last_login_at IS
  'Most recent successful authenticated login seen by PCP. NULL indicates an invited placeholder user that has never logged in.';
