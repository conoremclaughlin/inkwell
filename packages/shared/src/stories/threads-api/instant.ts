/**
 * Timestamps compared at the precision they were written with.
 *
 * Postgres keeps microseconds; Date.parse keeps milliseconds. Two messages
 * 0.8ms apart compare equal under Date.parse and fall back to whatever
 * breaks the tie — for thread paging, a UUID that says nothing about time,
 * which picked the wrong oldest message and sent the same cursor again
 * (Lumen, #670 round 2). Anything that orders messages, or compares one to
 * a read cursor, goes through here.
 */

const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i;

interface InstantParts {
  /** Whole seconds since the epoch, exact. */
  seconds: number;
  /** The fraction's digits, padded to nanoseconds so they compare as strings. */
  fraction: string;
}

function partsOf(iso: string): InstantParts {
  const match = ISO_INSTANT.exec(iso);
  if (!match) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return { seconds: -Infinity, fraction: '' };
    return {
      seconds: Math.floor(ms / 1000),
      fraction: String(ms - Math.floor(ms / 1000) * 1000)
        .padStart(3, '0')
        .padEnd(9, '0'),
    };
  }
  const [, wholeSeconds, digits = '', zone] = match;
  const ms = Date.parse(zone ? `${wholeSeconds}${zone}` : wholeSeconds);
  return {
    seconds: Number.isNaN(ms) ? -Infinity : ms / 1000,
    fraction: digits.padEnd(9, '0').slice(0, 9),
  };
}

/** Negative when `a` is earlier, positive when later, 0 for the same instant. */
export function compareInstants(a: string, b: string): number {
  const left = partsOf(a);
  const right = partsOf(b);
  if (left.seconds !== right.seconds) return left.seconds < right.seconds ? -1 : 1;
  if (left.fraction === right.fraction) return 0;
  return left.fraction < right.fraction ? -1 : 1;
}
