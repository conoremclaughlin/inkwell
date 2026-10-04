/**
 * The general ceiling on a backend turn.
 *
 * There is none unless one is configured. A turn that is still producing
 * output is never killed on wall-clock (Conor, 2026-10-04): every ceiling kill
 * in the thirty hours before that decision stopped a turn that was writing
 * seconds earlier (the turn-timeouts thread, 43920af1). A stuck turn is ended
 * by its runner's silence timeout or by Stop.
 *
 * `raw` is the runner's env var (CLAUDE_PROCESS_TIMEOUT_MS and its siblings).
 * A positive integer is a ceiling in milliseconds; anything else is none.
 */
export function ceilingFromEnv(raw: string | undefined): number | undefined {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The lowest of the ceilings given, or none when none is given. */
export function lowestCeiling(...ceilings: Array<number | undefined>): number | undefined {
  const given = ceilings.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
  );
  return given.length > 0 ? Math.min(...given) : undefined;
}
