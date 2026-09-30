import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getValidAccessToken } from '../../auth/tokens.js';
import { callInkTool, getInkServerUrl } from '../ink-mcp.js';
import { CodexMailDelivery, PendingCodexDelivery } from './delivery.js';
import { startCodexMailGateway } from './gateway.js';
import { pulseCodexMail } from './heartbeat.js';
import { splitCodexMailArgs } from './launch.js';
import { prepareCodexMailHooks, hasTrustedCodexMailHooks } from './hooks.js';
import { createCodexMailPoller } from './poller.js';

/** Experimental native-terminal adapter. Does not affect `codex exec`, the
 * desktop app, the global daemon, or any session not explicitly opted in. */
export async function runCodexMailInteractive(options: {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  sbSlug: string;
  sessionId: string;
  studioId: string;
  onBound(threadId: string): Promise<void>;
  onStderr(chunk: Buffer): void;
}): Promise<{ code: number | null; backendSessionId?: string }> {
  // Codex's hook trust keys include source paths. The TUI canonicalizes cwd;
  // use the same spelling for config/metadata queries (not /tmp vs /private/tmp).
  options = { ...options, cwd: realpathSync(options.cwd) };
  const version = spawnSync(options.binary, ['--version'], {
    env: options.env,
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  // Experimental queue/receipt schemas are measured on this version only.
  if (version.status !== 0 || !/^codex-cli 0\.159\.2\s*$/.test(version.stdout)) {
    throw new Error('Experimental Codex Inkmail currently requires codex-cli 0.159.2');
  }
  const launch = splitCodexMailArgs(options.args, options.cwd);
  const expectedHooks = prepareCodexMailHooks(options.cwd);
  // User feature overrides still follow this default; declining trust or
  // disabling hooks pauses delivery rather than bypassing that choice.
  launch.serverArgs.splice(1, 0, '--enable', 'hooks');
  const serverUrl = getInkServerUrl();
  let threadId: string | undefined;
  let delivery: CodexMailDelivery | undefined;
  let stopped = false;
  let switched = false;
  let polling = false;
  let stamping = false;
  let lastDiscovery = 0;
  let hooksReady = false;
  const warnings = new Set<string>();
  const warn = (message: string) => {
    if (warnings.has(message)) return;
    warnings.add(message);
    options.onStderr(Buffer.from(`\nInkwell Inkmail: ${message}\n`));
  };
  const gateway = await startCodexMailGateway({
    ...options,
    serverArgs: launch.serverArgs,
    threadOverrides: launch.threadOverrides,
    env: { ...options.env, INK_CODEX_INKMAIL: '1', INK_CHANNEL_HOST: 'codex' },
    onBound: async (id) => {
      if (threadId && threadId !== id) {
        switched = true;
        warn(
          'terminal changed Codex threads; live mail is paused. Relaunch ink for the selected thread.'
        );
        return;
      }
      threadId = id;
      await options.onBound(id);
      delivery = new CodexMailDelivery({
        directory: join(homedir(), '.ink', 'codex-mail'),
        scope: JSON.stringify([serverUrl, options.sbSlug, options.sessionId, options.studioId]),
        threadId: id,
        rpc: gateway,
      });
    },
    onEvent: (event) => delivery?.observe(event),
    onUnhealthy: () =>
      warn('live delivery disconnected; unconfirmed messages stay unread. Relaunch to recover.'),
  });
  const usable = () =>
    !stopped && !switched && hooksReady && Boolean(delivery) && gateway.isHealthy();
  const poll = createCodexMailPoller({
    sbSlug: options.sbSlug,
    studioId: options.studioId,
    callInk: async (tool, args) => {
      if (!usable()) throw new Error('Codex mail reader is not attached');
      const result = await callInkTool<Record<string, unknown>>(tool, args, {
        sessionId: options.sessionId,
        studioId: options.studioId,
        idempotent: tool.startsWith('get_'),
      });
      if (tool === 'get_inbox' && result.success && !result.channelPollIncomplete)
        lastDiscovery = Date.now();
      return result;
    },
    notify: async (content, meta, message) => {
      if (!usable()) throw new Error('Codex mail reader is not attached');
      // Drain summaries have no durable message id: show in the terminal,
      // never invent a mail receipt or inject a duplicate user turn.
      if (!message) {
        warn(content);
        return;
      }
      if (typeof message.id !== 'string') throw new Error('Inkmail row has no message identity');
      try {
        await delivery!.deliver(message.id, content, meta);
      } catch (error) {
        if (!(error instanceof PendingCodexDelivery)) {
          warn(error instanceof Error ? error.message : 'delivery failed; mail left unread');
        }
        throw error;
      }
    },
    log: (level, message) => {
      // Shared drain reports normal pending receipts as emit failures too.
      if (level === 'error' && !message.includes('emit') && !message.includes('notification'))
        warn(message);
    },
  });
  const pollTimer = setInterval(() => {
    if (stopped || switched || !delivery || !gateway.isHealthy() || polling) return;
    polling = true;
    (async () => {
      const config = await gateway.request('config/read', {
        cwd: options.cwd,
        includeLayers: false,
      });
      const hooks = await gateway.request('hooks/list', { cwds: [options.cwd] });
      hooksReady =
        config.config?.features?.hooks === true && hasTrustedCodexMailHooks(hooks, expectedHooks);
      if (!hooksReady) {
        warn(
          `review and trust the Inkwell hooks with /hooks before live mail can run; unread mail is untouched (feature: ${config.config?.features?.hooks === true ? 'enabled' : 'disabled'}, trusted handlers: ${hasTrustedCodexMailHooks(hooks, expectedHooks) ? 'yes' : 'no'}).`
        );
        return;
      }
      const drained = await poll();
      if (drained.threadResult.fetchFailures > 0) lastDiscovery = 0;
    })()
      .catch(() => warn('mailbox poll failed; will retry without advancing unread pointers.'))
      .finally(() => {
        polling = false;
      });
  }, 5000);
  // Receipt waits never block freshness. Conversely, owner/transport death
  // stops stamps immediately, and mailbox outages expire within one window.
  const heartbeatTimer = setInterval(() => {
    if (!usable() || stamping || Date.now() - lastDiscovery > 20_000) return;
    stamping = true;
    void pulseCodexMail({
      usable,
      lastDiscovery: () => lastDiscovery,
      probe: () => gateway.request('thread/queue/list', { threadId, limit: 1 }),
      credential: () => getValidAccessToken(serverUrl),
      stamp: async (token) => {
        const response = await fetch(`${serverUrl}/api/hooks/lifecycle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            sessionId: options.sessionId,
            cliPollAt: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('Heartbeat refused');
      },
    })
      .catch(() =>
        warn(
          'delivery heartbeat failed; terminal ownership must not be inferred from a stale stamp.'
        )
      )
      .finally(() => {
        stamping = false;
      });
  }, 5000);
  try {
    const child = spawn(options.binary, ['--remote', gateway.endpoint, ...launch.tuiArgs], {
      cwd: options.cwd,
      env: { ...options.env, INK_CODEX_INKMAIL: '1', INK_CHANNEL_HOST: 'codex' },
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    child.stderr.on('data', options.onStderr);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, backendSessionId: threadId };
  } finally {
    stopped = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    // Caller detaches and removes the identity prompt ONLY after the owner
    // has exited. The guardian also enforces this on abrupt wrapper death.
    await gateway.stop();
  }
}
