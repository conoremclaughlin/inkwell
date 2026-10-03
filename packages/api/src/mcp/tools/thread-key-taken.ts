/**
 * A create-only send (InternalSendContext.createOnly) found its thread key
 * already in use: by a thread that existed before the send, or by one a
 * concurrent request created between the lookup and the insert. It is thrown
 * before any participant or message is written, so nothing about the
 * existing thread changed.
 *
 * Its own module so that callers can recognise it while tests replace the
 * send handler itself.
 */
export class ThreadKeyTakenError extends Error {
  readonly code = 'THREAD_KEY_TAKEN';

  constructor(readonly threadKey: string) {
    super(`A thread with key "${threadKey}" already exists`);
    this.name = 'ThreadKeyTakenError';
  }
}
