import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Configuration-only native probe. Never starts/resumes a thread or executes a
 * hook/model turn. Use the exact owner arguments/environment, not a home-config
 * approximation: linked worktrees can load main's config under a studio label.
 * The guardian owns/reaps its child on timeout, error, or wrapper death. */
export async function probeCodexMailHooks(options: {
  binary: string;
  serverArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./guardian.js', import.meta.url)),
      options.binary,
      ...options.serverArgs,
    ],
    {
      cwd: options.cwd,
      env: { ...options.env, INK_CODEX_INKMAIL: '0' },
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    }
  );
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let serial = 0;
  let rejectPending: ((error: Error) => void) | undefined;
  let receive: ((message: Record<string, any>) => void) | undefined;
  let failed = false;
  const fail = () => {
    failed = true;
    rejectPending?.(new Error('Codex hook configuration probe failed'));
  };
  child.on('error', fail);
  child.on('close', fail);
  child.stdin.on('error', fail);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      receive?.(JSON.parse(line));
    } catch {
      fail();
    }
  });
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, any>>((resolve, reject) => {
      if (failed) return reject(new Error('Codex hook configuration probe is unavailable'));
      const id = ++serial;
      const timer = setTimeout(() => {
        reject(new Error('Codex hook configuration probe timed out'));
      }, 10_000);
      rejectPending = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      receive = (message) => {
        if (message.id !== id || message.method) return;
        clearTimeout(timer);
        // Never echo native error/config text: it may contain private overrides.
        if (message.error) reject(new Error(`Codex refused the ${method} hook probe`));
        else resolve(message.result ?? {});
      };
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  try {
    await request('initialize', {
      clientInfo: { name: 'ink_hook_preflight', version: '1' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const config = await request('config/read', { cwd: options.cwd, includeLayers: true });
    const hooks = await request('hooks/list', { cwds: [options.cwd] });
    return {
      hooks,
      enabled: config.config?.features?.hooks === true,
      sessionHooks: (config.layers ?? []).some(
        (layer: Record<string, any>) =>
          layer.name?.type === 'sessionFlags' && layer.config?.hooks !== undefined
      ),
    };
  } finally {
    receive = undefined;
    rejectPending = undefined;
    child.stdin.end();
    await closed;
    lines.close();
  }
}
