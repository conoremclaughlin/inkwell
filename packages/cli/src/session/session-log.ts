import { appendFileSync } from 'fs';
import { appendFile } from 'fs/promises';

import {
  SessionLog as RuntimeSessionLog,
  type SessionLogOptions as RuntimeSessionLogOptions,
  type SessionLogSink,
} from '@inklabs/shared/runtime';

export { OBS_PROJECTION_TYPES, type SessionLogSink } from '@inklabs/shared/runtime';

/** CLI compatibility: existing callers keep the synchronous file default. */
export interface SessionLogOptions extends Omit<RuntimeSessionLogOptions, 'sink'> {
  sink?: SessionLogSink;
}

/** Append each entry to a JSONL file, blocking until it is written. */
export function jsonlFileSink(path: string): SessionLogSink {
  return { write: (line) => appendFileSync(path, line) };
}

/**
 * Append each entry to a JSONL file without blocking the event loop. The file
 * must only be written through one SessionLog: concurrent appends to one path
 * are not ordered, and the log's serialization is what orders them.
 */
export function asyncJsonlFileSink(path: string): SessionLogSink {
  return { write: (line) => appendFile(path, line) };
}

/** Filesystem policy belongs to this host, not to the shared journal. */
export class SessionLog extends RuntimeSessionLog {
  constructor(options: SessionLogOptions) {
    super({ ...options, sink: options.sink ?? jsonlFileSink(options.path) });
  }
}
