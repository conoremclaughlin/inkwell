/** Private, generation-local native steering evidence. Never a hosted resume ledger. */
import { mkdir, lstat, mkdtemp, open, realpath } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { SessionLog } from '@inklabs/shared/runtime';

export interface NativeSteeringLog {
  readonly path: string;
  append(event: Record<string, unknown>): number;
  flush(): Promise<void>;
  close(): Promise<void>;
}

const EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  native_steering_request: ['messageId', 'text'],
  native_steering_observation: ['messageId'],
  native_steering_receipt: ['messageId', 'status', 'reason', 'observationEid'],
};

/** A fresh directory and exclusive file every time; previous intents are never resumed. */
export async function openNativeSteeringLog(input: {
  cwd: string;
  sessionId: string;
  turnEpoch: string;
  signal?: AbortSignal;
}): Promise<NativeSteeringLog> {
  const { cwd, sessionId, turnEpoch, signal } = input;
  const safePart = (value: string) => /^[a-z0-9-]{1,128}$/i.test(value);
  if (!isAbsolute(cwd) || !safePart(sessionId) || !safePart(turnEpoch))
    throw new Error('Invalid native steering journal identity or working directory');
  signal?.throwIfAborted();
  let dir = await realpath(cwd);
  for (const part of ['.ink', 'runtime', 'native-steering']) {
    dir = join(dir, part);
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Native steering journal requires real directories');
    if (part === 'native-steering' && (info.mode & 0o077) !== 0)
      throw new Error('Native steering journal directory is not private');
  }
  signal?.throwIfAborted();
  dir = await mkdtemp(join(dir, `${sessionId}-${turnEpoch}-`));
  const path = join(dir, 'events.jsonl');
  const file = await open(path, 'wx', 0o600);
  try {
    signal?.throwIfAborted();
  } catch (error) {
    await file.close();
    throw error;
  }
  const log = new SessionLog({
    path,
    sink: {
      // Always async: SessionLog makes both write and sync failures sticky.
      async write(line) {
        await file.appendFile(line);
        await file.sync();
      },
    },
  });
  let closing: Promise<void> | undefined;
  return {
    path,
    append(event) {
      if (closing) throw new Error('Native steering journal is closed');
      const fields =
        typeof event.type === 'string' && Object.hasOwn(EVENT_FIELDS, event.type)
          ? EVENT_FIELDS[event.type]
          : undefined;
      if (!fields || event.version !== 1 || event.turnEpoch !== turnEpoch)
        throw new Error('Invalid native steering journal event');
      // Only native evidence fields enter this file; callers cannot replace eids or timestamps.
      const record: Record<string, unknown> = {
        type: event.type,
        version: 1,
        turnEpoch,
      };
      for (const field of fields) if (event[field] !== undefined) record[field] = event[field];
      return log.append(record);
    },
    flush: () => log.flush(),
    close() {
      return (closing ??= (async () => {
        let failure: { error: unknown } | undefined;
        try {
          await log.close();
        } catch (error) {
          failure = { error };
        }
        try {
          await file.close();
        } catch (error) {
          failure ??= { error };
        }
        if (failure) throw failure.error;
      })());
    },
  };
}
