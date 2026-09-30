/**
 * Wrap async work so every call shares one run: the first call starts it,
 * and every later call, including one made while it is still running,
 * receives the same promise.
 *
 * A started flag is not enough for async work. A second caller that sees the
 * flag and returns at once can go on to exit the process while the first
 * caller's work is still pending (Lumen, #701 review of 72027fba).
 */
export function onceAsync<T>(work: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  return () => (running ??= work());
}
