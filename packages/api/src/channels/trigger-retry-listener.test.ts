/**
 * The retry decision as `server.ts` actually makes it.
 *
 * The scheduler has its own unit tests, and they all passed while the wiring
 * around them was wrong in three separate ways (Lumen, r2): a routing refusal
 * was re-dispatched because its prose named thread "pr:503", a pending timer
 * outlived the delivery it was waiting for, and a threaded failure went silent
 * with nothing durable behind it. None of those live in the scheduler. They
 * live in the listener, and the listener had no test.
 *
 * It had none because `server.ts` ends in an unconditional `startServer()`, so
 * importing it boots a server. So the three pieces that matter — the default
 * handler, the scheduler declaration, the `trigger:error` listener — are
 * lifted out of the real file by their AST and run in a VM against fakes.
 * This is deliberately not a model of the listener: the source under test is
 * the source that ships, and editing server.ts changes what these assertions
 * see. The harness is Lumen's, from the review probes; it is committed here
 * because a regression that only exists in a reviewer's scratch directory is
 * not a regression, which is the lesson from #539 r4.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'node:vm';
import ts from 'typescript';

const API_SRC = resolve(__dirname, '..');
const SERVER = resolve(API_SRC, 'server.ts');
const SESSION_SERVICE = resolve(API_SRC, 'services/sessions/session-service.ts');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function transpile(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

/** The source text of the first node in `file` matching `predicate`. */
function extract(file: string, predicate: (n: ts.Node) => boolean): string {
  const source = readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let match: ts.Node | undefined;
  const walk = (n: ts.Node) => {
    if (predicate(n)) match = n;
    ts.forEachChild(n, walk);
  };
  walk(ast);
  if (!match) throw new Error(`AST node not found in ${file} — did server.ts move?`);
  return match.getText(ast);
}

/** Load a module's source in a VM with its imports replaced by `deps`. */
function loadModule(
  file: string,
  deps: Record<string, unknown>,
  globals: Record<string, unknown> = {}
): Record<string, unknown> {
  const mod = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(transpile(readFileSync(file, 'utf8')), {
    module: mod,
    exports: mod.exports,
    require: (name: string) => {
      if (name in deps) return deps[name];
      throw new Error(`unexpected import ${name}`);
    },
    ...globals,
  });
  return mod.exports;
}

type Timer = { fn: () => void; ms: number; cancelled?: boolean; unref(): void };

let handlerSource: string;
let schedulerSource: string;
let listenerSource: string;
let RoutingRefusedError: new (
  threadKey: string,
  sbSlug: string,
  detail: Record<string, unknown>
) => Error;

beforeAll(() => {
  handlerSource = extract(
    SERVER,
    (n) =>
      ts.isCallExpression(n) && n.expression.getText().endsWith('agentGateway.setDefaultHandler')
  );
  listenerSource = extract(
    SERVER,
    (n) =>
      ts.isCallExpression(n) &&
      n.expression.getText() === 'agentGateway.on' &&
      ts.isStringLiteral(n.arguments[0]) &&
      (n.arguments[0] as ts.StringLiteral).text === 'trigger:error'
  );
  schedulerSource = extract(
    SERVER,
    (n) =>
      ts.isVariableStatement(n) &&
      n.declarationList.declarations.some((d) => d.name.getText() === 'triggerRetryScheduler')
  );

  const classSource = extract(
    SESSION_SERVICE,
    (n) => ts.isClassDeclaration(n) && n.name?.text === 'RoutingRefusedError'
  ).replace(/^export /, '');
  RoutingRefusedError = new Function(
    `${transpile(classSource)};return RoutingRefusedError`
  )() as typeof RoutingRefusedError;
});

interface RigOptions {
  planRefusal?: Error;
  /** Make the terminal hold-clear throw, the way a network dip does. */
  cleanupThrows?: boolean;
  /** Refuse from handleMessage's own admission, as a structured result. */
  resultRefusal?: { threadKey: string; detail: Record<string, unknown> };
}

function rig(options: RigOptions = {}) {
  let sessionTurns = 0;
  const timers: Timer[] = [];
  const writes: Array<{ table: string; op: string; value?: Record<string, unknown> }> = [];
  const activities: Array<Record<string, unknown>> = [];
  const redispatched: Array<Record<string, unknown>> = [];

  const retryModule = loadModule(
    resolve(API_SRC, 'channels/trigger-retry.ts'),
    { '../utils/logger': { logger: silentLogger } },
    {
      setTimeout(fn: () => void, ms: number) {
        const t: Timer = { fn, ms, unref() {} };
        timers.push(t);
        return t;
      },
      clearTimeout(t: Timer) {
        t.cancelled = true;
      },
    }
  );

  const row: Record<string, unknown> = {
    user_id: 'user-synthetic',
    recipient_user_id: 'user-synthetic',
    recipient_sb_id: null,
    thread_id: 'thread-synthetic',
    status: 'read',
  };

  const client = {
    from(table: string) {
      const q = {
        table,
        op: 'select' as string,
        cols: '' as string,
        value: undefined as unknown,
        select(cols: string) {
          q.cols = cols;
          return q;
        },
        update(value: unknown) {
          q.op = 'update';
          q.value = value;
          return q;
        },
        insert(value: unknown) {
          q.op = 'insert';
          q.value = value;
          return q;
        },
        eq: () => q,
        single: () => q.run(),
        maybeSingle: () => q.run(),
        then: (a: (v: unknown) => unknown, b?: (e: unknown) => unknown) => q.run().then(a, b),
        async run() {
          if (q.op !== 'select') {
            writes.push({ table, op: q.op, value: q.value as Record<string, unknown> });
            if (table === 'agent_inbox') Object.assign(row, q.value);
            return { data: null, error: null };
          }
          if (table === 'agent_identities') {
            return {
              data: [{ id: 'identity-synthetic', workspace_id: 'workspace-synthetic' }],
              error: null,
            };
          }
          if (table === 'sessions') {
            return {
              data: q.cols.includes('cli_poll') ? null : { cli_attached: false },
              error: null,
            };
          }
          return { data: row, error: null };
        },
      };
      return q;
    },
  };

  const gateway = {
    handler: undefined as ((p: Record<string, unknown>) => Promise<unknown>) | undefined,
    listener: undefined as ((e: Record<string, unknown>) => Promise<void>) | undefined,
    setDefaultHandler(fn: (p: Record<string, unknown>) => Promise<unknown>) {
      gateway.handler = fn;
    },
    on(_name: string, fn: (e: Record<string, unknown>) => Promise<void>) {
      gateway.listener = fn;
    },
    dispatchTrigger(payload: Record<string, unknown>) {
      redispatched.push(payload);
      return { success: true, accepted: true };
    },
  };

  const deps = {
    logger: silentLogger,
    agentGateway: gateway,
    dataComposer: {
      getClient: () => client,
      repositories: {
        activityStream: {
          async logActivity(a: Record<string, unknown>) {
            activities.push(a);
          },
        },
      },
    },
    sessionService: {
      async getOrCreateSession() {
        if (options.planRefusal) throw options.planRefusal;
        return { id: 'session-synthetic', messageCount: 1 };
      },
      async handleMessage() {
        if (options.resultRefusal) {
          return {
            success: false,
            errorCode: 'ROUTING_REFUSED',
            refusal: options.resultRefusal,
            error: `Refusing to route "${options.resultRefusal.threadKey}" for agent "recipient-test"`,
          };
        }
        sessionTurns += 1;
        return { success: true };
      },
      async getSession() {
        return null;
      },
      async endSession() {},
    },
    getUserFromContext: () => ({ userId: 'user-synthetic' }),
    logInkmail: async () => {},
    assignThreadParticipant: async () => ({ stampPersisted: true }),
    clearRoutingHold: async () => {
      if (options.cleanupThrows) throw new Error('fetch failed');
      return true;
    },
    stampRoutingHold: async () => true,
    decideDelivery: () => ({ mode: 'spawn' }),
    storedTriggerMedia: async () => [],
    routeResponses: async () => {},
    RoutingRefusedError,
    sendTriggerFailureNotice: loadModule(resolve(API_SRC, 'services/trigger-failure-notice.ts'), {
      '../utils/logger': { logger: silentLogger },
    }).sendTriggerFailureNotice,
    ...loadModule(resolve(API_SRC, '../../shared/src/errors/classify-error.ts'), {}),
    ...retryModule,
  };

  // The three fragments are re-composed scheduler-first, because `new Function`
  // runs its body top to bottom and the handler closes over the scheduler. In
  // server.ts itself the handler comes first and relies on the closure instead.
  // That difference is why `describe('server.ts wiring')` below checks the real
  // file's shape separately — this harness cannot see it.
  new Function(
    ...Object.keys(deps),
    transpile([schedulerSource, handlerSource, listenerSource].join(';\n'))
  )(...Object.values(deps));

  const threadPayload = {
    fromSlug: 'sender-test',
    toSlug: 'recipient-test',
    triggerType: 'message',
    threadKey: 'pr:42',
    threadId: 'thread-synthetic',
    threadMessageId: 'message-synthetic',
  };

  return {
    gateway,
    timers,
    writes,
    activities,
    redispatched,
    row,
    threadPayload,
    get sessionTurns() {
      return sessionTurns;
    },
    async fail(
      payload: Record<string, unknown> = threadPayload,
      error: unknown = new Error('fetch failed')
    ) {
      await gateway.listener!({ triggerId: 'trigger-synthetic', payload, error });
    },
  };
}

describe('a routing refusal is never retried', () => {
  // The refusal message names the thread it refused, and classifyError reads
  // prose: "pr:503" matches the capacity rule's /\b503\b/ and "debug:timeout"
  // matches the timeout rule. Both are retryable categories, so a message the
  // router deliberately HELD was being re-dispatched two minutes later — and
  // the immediate notice the sender should have seen was suppressed to wait
  // for it. The thread key alone decided, which is the worst kind of bug to
  // own: correct for pr:42, wrong for pr:503.
  for (const threadKey of ['pr:42', 'pr:503', 'debug:timeout']) {
    it(`schedules nothing for a refusal on thread ${threadKey}`, async () => {
      const refusal = new RoutingRefusedError(threadKey, 'recipient-test', {
        triedCallerRepo: false,
        reason: 'no-route',
      });
      const r = rig({ planRefusal: refusal });
      const payload = { ...r.threadPayload, threadKey };

      let thrown: unknown;
      try {
        await r.gateway.handler!(payload);
      } catch (err) {
        thrown = err;
      }
      expect(
        thrown,
        'the handler must still throw — the refusal has to reach the listener'
      ).toBeTruthy();

      await r.fail(payload, thrown);
      expect(r.timers).toHaveLength(0);
    });
  }

  it('still retries an ordinary transient failure', async () => {
    // The control. A guard that refused everything would pass all three cases
    // above while removing the feature, and would look exactly the same.
    const r = rig();
    await r.fail(r.threadPayload, new Error('fetch failed'));
    expect(r.timers).toHaveLength(1);
  });
});

describe('a delivery that lands by another route cancels the pending retry', () => {
  it('does not re-dispatch a message that was already handled', async () => {
    const r = rig();
    const payload = {
      ...r.threadPayload,
      threadId: undefined,
      threadMessageId: undefined,
      threadKey: undefined,
      inboxMessageId: 'inbox-synthetic',
    };

    await r.fail(payload);
    expect(r.timers).toHaveLength(1);

    // A heartbeat scan picks the restored-to-unread row up and delivers it.
    // Structured-cloned on purpose: this is a DIFFERENT payload object, which
    // is why stamping triggerTurnCompleted on it cannot reach the timer, and
    // why the cancel has to key off the message instead.
    const viaOtherRoute = structuredClone(payload);
    await r.gateway.handler!(viaOtherRoute);

    for (const t of r.timers) if (!t.cancelled) t.fn();
    for (const delayed of r.redispatched) await r.gateway.handler!(delayed);

    expect(viaOtherRoute.metadata?.triggerTurnCompleted).toBe(true);
    expect(r.redispatched).toHaveLength(0);
    expect(r.sessionTurns).toBe(1);
  });
});

describe('a pending retry stays silent only when something durable survives', () => {
  it('speaks once for a thread-borne failure, which has no row to restore', async () => {
    // Thread read state is a monotonic last_read_at, so there is no per-message
    // unread flag to put back. Suppressing the notice here would mean a restart
    // during the backoff drops the message with no timer, no row and nothing
    // said — worse than the behaviour this PR replaces.
    const r = rig();
    await r.fail(r.threadPayload);

    expect(r.timers).toHaveLength(1);
    expect(r.writes.length).toBeGreaterThan(0);
  });

  it('stays quiet for an agent_inbox failure, where the row is the fallback', async () => {
    // The other half, and the reason the case above is not just "always
    // notify": restoring the row to unread is itself the durable record, so the
    // sender does not need telling until the attempts run out.
    const r = rig();
    const payload = {
      ...r.threadPayload,
      threadId: undefined,
      threadMessageId: undefined,
      threadKey: undefined,
      inboxMessageId: 'inbox-synthetic',
    };
    await r.fail(payload);

    expect(r.timers).toHaveLength(1);
    // The only write is the unread restore; no notice was inserted.
    expect(r.writes.filter((w) => w.op === 'insert')).toHaveLength(0);
    expect(r.writes.some((w) => w.table === 'agent_inbox' && w.op === 'update')).toBe(true);
  });
});

describe('server.ts wiring', () => {
  // The harness above lifts three fragments out and re-composes them, so it is
  // blind to how they nest in the file they came from. That blindness has
  // already cost once: hoisting the scheduler above the handler swallowed the
  // registration into the scheduler's own callback, so setDefaultHandler would
  // have run only when a retry fired — meaning never, since nothing was
  // registered to fail. tsc accepted it (nesting is valid TypeScript), every
  // test here passed (the fragments are extracted independently), and the only
  // visible symptom was 666 lines that prettier re-indented.
  it('registers the default handler directly in startServer, not inside a callback', () => {
    const source = readFileSync(SERVER, 'utf8');
    const ast = ts.createSourceFile(SERVER, source, ts.ScriptTarget.Latest, true);

    let call: ts.Node | undefined;
    const walk = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        n.expression.getText(ast).endsWith('agentGateway.setDefaultHandler')
      ) {
        call = n;
      }
      ts.forEachChild(n, walk);
    };
    walk(ast);
    expect(call, 'setDefaultHandler call not found in server.ts').toBeTruthy();

    // Nearest enclosing function: it must be startServer itself.
    let parent: ts.Node | undefined = call!.parent;
    while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;

    expect(
      parent && ts.isFunctionDeclaration(parent) ? parent.name?.text : '(not a declaration)'
    ).toBe('startServer');
  });
});

describe('the notice sequence across all three attempts', () => {
  // The shape of the thread-borne fallback, start to finish. Asserting only
  // "a notice was written" would pass just as well if every attempt wrote one,
  // which is the noise the suppression exists to avoid. (Scenario from Lumen's
  // r2 follow-up probes.)
  it('announces the first failure, stays quiet on the retry, then reports exhaustion', async () => {
    const r = rig();
    const notices = () =>
      r.writes.filter((w) => w.table === 'inbox_thread_messages' && w.op === 'insert');

    await r.fail();
    expect(notices()).toHaveLength(1);
    expect((notices()[0].value?.metadata as Record<string, unknown>).retryPending).toBe(2);
    expect(notices()[0].value?.content).toMatch(/retrying \(2\/3\) in 120s/);

    // Attempt 2 fails: already announced, so nothing new is said.
    r.timers[0].fn();
    await r.fail(r.redispatched[0]);
    expect(notices()).toHaveLength(1);
    expect(r.timers).toHaveLength(2);

    // Attempt 3 fails: attempts exhausted, so the final notice lands.
    r.timers[1].fn();
    await r.fail(r.redispatched[1]);
    expect(notices()).toHaveLength(2);
    const final = notices()[1].value?.metadata as Record<string, unknown>;
    expect(final.retryPending).toBeNull();
    expect(final.attempts).toBe(3);
    expect(notices()[1].value?.content).toMatch(/after 3 attempts/);
    expect(r.timers, 'nothing is scheduled past the cap').toHaveLength(2);
  });
});

describe('a refusal surfacing as a structured result, not a throw from planning', () => {
  // The other half of the refusal path. The plan-time refusal rethrows the real
  // error; this one comes back as errorCode ROUTING_REFUSED on a result and used
  // to be flattened into a bare Error, which is precisely where the code was
  // lost. Same three thread keys, because the misclassification was the key.
  for (const threadKey of ['pr:42', 'pr:503', 'debug:timeout']) {
    it(`carries the code and notifies immediately for ${threadKey}`, async () => {
      const r = rig({
        resultRefusal: {
          threadKey,
          detail: { triedCallerRepo: false, reason: 'no-route' as const },
        },
      });
      const payload = { ...r.threadPayload, threadKey };

      let thrown: unknown;
      try {
        await r.gateway.handler!(payload);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { code?: string })?.code).toBe('ROUTING_REFUSED');

      await r.fail(payload, thrown);
      expect(r.timers).toHaveLength(0);
      expect(
        r.writes.filter((w) => w.table === 'inbox_thread_messages' && w.op === 'insert')
      ).toHaveLength(1);
    });
  }
});

describe('fan-out cancellation is per recipient', () => {
  // One thread message triggering two recipients gets two independent timers.
  // A turn completing for one of them must not cancel the other's — and the
  // cancel has to happen before the terminal cleanup, which can throw.
  it('cancels only the recipient whose turn completed', async () => {
    const r = rig({ cleanupThrows: true });
    await r.fail();
    await r.fail({ ...r.threadPayload, toSlug: 'other-recipient' });
    expect(r.timers).toHaveLength(2);

    try {
      await r.gateway.handler!(structuredClone(r.threadPayload));
    } catch {
      // The hold clear throws on purpose; the cancel above it must already have run.
    }

    expect(r.timers[0].cancelled).toBe(true);
    expect(r.timers[1].cancelled).toBeUndefined();

    for (const t of r.timers) if (!t.cancelled) t.fn();
    expect(r.redispatched).toHaveLength(1);
    expect(r.redispatched[0].toSlug).toBe('other-recipient');
  });
});
