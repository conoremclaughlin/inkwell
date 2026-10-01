-- A session can say, in one line, what it is working on
--
-- `sessions.context` already holds real operational state and nothing surfaces
-- it: reading it takes an explicit get_session that nobody makes casually. The
-- obvious fix — print `context` as a status line — does not survive contact
-- with the data. Measured 2026-09-15 over the 90 sessions touched in the last
-- 7 days:
--
--   median context length        349 chars
--   p90                          974
--   max                        5,200
--   within 280 chars             30.0%
--   multiline                    4 of 90
--
-- The all-time median is 132, which looks like a usable status line and is
-- misleading: it is dominated by old short entries, and current practice is
-- 2.6x longer. And because only 4 of 90 are multiline, there is no first line
-- to lift as a lead — the first line IS the paragraph (median 322 of 349). So
-- neither truncation nor derivation produces something readable, and a
-- dedicated short field is the honest answer.
--
-- `headline` is that field, bounded so it cannot quietly become a second
-- context block. `context` keeps its role as the scratch board.

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS headline TEXT,
  ADD COLUMN IF NOT EXISTS headline_updated_at TIMESTAMPTZ,
  -- Without this, the age of `context` is unknowable: sessions.updated_at moves
  -- on every write (lifecycle, phase, cli_attached), so it cannot say when the
  -- narrative was last true. That gap is what let a context block written on
  -- 11 Sep, describing round five, be read on 15 Sep as a current claim about a
  -- PR then at round eight.
  ADD COLUMN IF NOT EXISTS context_updated_at TIMESTAMPTZ;

ALTER TABLE public.sessions
  DROP CONSTRAINT IF EXISTS sessions_headline_length;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_headline_length
  CHECK (headline IS NULL OR char_length(headline) <= 120) NOT VALID;

-- No existing row has a headline, so this validates trivially — run it anyway
-- rather than leaving a constraint nothing has ever checked.
ALTER TABLE public.sessions VALIDATE CONSTRAINT sessions_headline_length;

COMMENT ON COLUMN public.sessions.headline IS
  'One line, max 120 chars: what this session is working on RIGHT NOW. Displayed wherever sessions are listed. Distinct from context, which is the longer scratch board (median 349 chars in practice) and too long to show in a list.';
COMMENT ON COLUMN public.sessions.headline_updated_at IS
  'When the headline was last written. Displayed beside it — a headline without an age is read as current however old it is.';
COMMENT ON COLUMN public.sessions.context_updated_at IS
  'When context was last written. NULL on rows predating this column, which is why readers must treat a missing age as unknown rather than as recent.';
