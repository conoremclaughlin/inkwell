/**
 * Keep a test's outbound sockets on loopback, whatever the code under test
 * does.
 *
 * The web_fetch tests prove refusals by showing a local server was never
 * reached. A refusal that regresses must fail the test without the code
 * under test connecting to a real internal address on the way, and the
 * metadata and private-range cases name exactly such addresses. So every
 * socket connect is checked here first: an IP that isn't 127.0.0.1 or ::1 is
 * refused, and a name must come with its own lookup (the guard's pinned one),
 * whose answers are refused the same way. A refused dial destroys the socket
 * with an error; nothing leaves the machine.
 */

import net, { type LookupFunction } from 'node:net';
import { vi } from 'vitest';

const LOOPBACK = new Set(['127.0.0.1', '::1']);

type LookupAnswer = { address: string; family: number };

function fencedLookup(lookup: LookupFunction, dialed: string[]): LookupFunction {
  return ((host: string, options: unknown, callback: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAnswer[],
      family?: number
    ) => void;
    const opts = typeof options === 'function' ? {} : options;
    (lookup as (h: string, o: unknown, c: unknown) => void)(
      host,
      opts,
      (err: NodeJS.ErrnoException | null, address: string | LookupAnswer[], family?: number) => {
        if (err) return cb(err, '');
        const answers = Array.isArray(address) ? address : [{ address, family: family ?? 4 }];
        const outside = answers.find((answer) => !LOOPBACK.has(answer.address));
        if (outside) return cb(new Error(`dial fence: lookup answered ${outside.address}`), '');
        dialed.push(...answers.map((answer) => answer.address));
        return cb(null, address, family);
      }
    );
  }) as LookupFunction;
}

export interface DialFence {
  /** Every address a socket was allowed to dial, in order. */
  dialed: string[];
  restore: () => void;
}

export function installDialFence(): DialFence {
  const dialed: string[] = [];
  const realConnect = net.Socket.prototype.connect;
  const spy = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const first = args[0];
    const options = (
      Array.isArray(first)
        ? first[0]
        : typeof first === 'object' && first !== null
          ? first
          : { port: first, host: args[1] }
    ) as { host?: string; path?: string; lookup?: LookupFunction };
    if (options.path === undefined) {
      const host = String(options.host ?? 'localhost').replace(/^\[|\]$/g, '');
      let refusal: string | null = null;
      if (net.isIP(host)) {
        if (LOOPBACK.has(host)) dialed.push(host);
        else refusal = `dial fence: refused to dial ${host}`;
      } else if (!options.lookup) {
        refusal = `dial fence: ${host} would go to the system resolver`;
      } else {
        options.lookup = fencedLookup(options.lookup, dialed);
      }
      if (refusal) {
        const error = new Error(refusal);
        process.nextTick(() => this.destroy(error));
        return this;
      }
    }
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  });
  return { dialed, restore: () => spy.mockRestore() };
}
