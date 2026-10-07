/**
 * Exit once everything already written to stdout and stderr has been handed
 * to the operating system.
 *
 * `process.exit()` does not wait for a pipe. On macOS a pipe to stdout is
 * asynchronous, so output larger than the pipe buffer (about 64KB) is cut off
 * at exit while the status still says 0. Lumen reproduced it on `ink wait`
 * (#702): a 1000-message batch, exit 0, 305 lines received and the last
 * message missing.
 *
 * A zero-length write queues behind everything written before it, so its
 * callback fires once those writes have gone through. A stream that is
 * already closed has nothing left to deliver and is not waited on.
 */
export async function exitAfterFlush(code: number): Promise<never> {
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
  process.exit(code);
}

function drained(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || !stream.writable) {
      resolve();
      return;
    }
    // The callback also fires with an error (EPIPE when the reader has gone):
    // then there is nothing more to wait for either.
    stream.write('', () => resolve());
  });
}
