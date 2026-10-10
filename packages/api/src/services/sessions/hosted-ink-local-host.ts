/** Local host wiring. The runtime stays async/in-process; only providers/tools spawn. */
import { execFile } from 'child_process';
import { access, stat } from 'fs/promises';
import { constants } from 'fs';
import { delimiter, isAbsolute, join } from 'path';
import { promisify } from 'util';
import { buildCleanEnv } from '@inklabs/shared';
import {
  discoverHostedSkillMcpServers,
  readHostKeychainCredentials,
} from '@inklabs/shared/node-host';
import { createBoundHostedInkRunner } from './hosted-ink-binding';
import { createHostedInkEffects } from './hosted-ink-effects';
import { createHostedInkCoding } from './hosted-ink-coding';
import { sessionEventBus, type ObserverEntry } from './session-event-bus';
import { getActiveRun } from './active-runs';

const exec = promisify(execFile);
export function createLocalHostedInkRunner(input: {
  home: string;
  tempDir: string;
  studiosRoot: string;
  baseEnv: Readonly<NodeJS.ProcessEnv>;
  mcpUrl: string;
  platform: string;
  warn(message: string): void;
}) {
  for (const path of [input.home, input.tempDir, input.studiosRoot])
    if (!isAbsolute(path)) throw new Error('Local Ink host roots must be absolute');
  const baseEnv: Readonly<NodeJS.ProcessEnv> = Object.freeze({
    ...buildCleanEnv({}, { ...input.baseEnv }),
    HOME: input.home,
  });
  const paths = Object.freeze({
    inkFiles: join(input.home, '.ink', 'files'),
    studiosRoot: input.studiosRoot,
    tempDir: input.tempDir,
  });
  const searchDirs = [
    ...new Set([
      ...(baseEnv.PATH ?? '').split(delimiter).filter(isAbsolute),
      join(input.home, '.local', 'bin'),
      join(input.home, '.pi', 'agent', 'bin'),
    ]),
  ];
  const resolveBinary = async (name: string) => {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid hosted executable name');
    for (const dir of searchDirs) {
      const path = join(dir, name);
      try {
        if (!(await stat(path)).isFile()) continue;
        await access(path, constants.X_OK);
        return path;
      } catch {
        /* Try the next explicit host directory, never a login shell. */
      }
    }
    throw new Error(`Hosted executable is unavailable: ${name}`);
  };
  let partialSupport: Promise<boolean> | undefined;
  const runner = createBoundHostedInkRunner({
    baseEnv,
    paths,
    mcpUrl: input.mcpUrl,
    resolveBinary,
    claudeSupportsPartialMessages: () =>
      (partialSupport ??= (async () => {
        try {
          const { stdout } = await exec(await resolveBinary('claude'), ['--help'], {
            env: { ...baseEnv },
            cwd: input.home,
            timeout: 5000,
            maxBuffer: 1024 * 1024,
          });
          return stdout.includes('--include-partial-messages');
        } catch {
          return false;
        }
      })()),
    skillMcpServers: (cwd) => discoverHostedSkillMcpServers(cwd, input.home),
    warn: input.warn,
    prepareEffects: createHostedInkEffects({
      home: input.home,
      tempDir: input.tempDir,
      inkFiles: paths.inkFiles,
      policyPath: join(input.home, '.ink', 'security', 'tool-policy.json'),
      mcpUrl: input.mcpUrl,
      coding: async (turn, signal, sessionEnv) =>
        createHostedInkCoding({
          cwd: turn.workingDirectory,
          tempDir: input.tempDir,
          env: baseEnv,
          sessionEnv,
          shell: await resolveBinary('bash'),
          resolveBinary,
          signal,
        }),
      credentials: (_turn, signal) =>
        readHostKeychainCredentials({ platform: input.platform, env: baseEnv, signal }),
      // CLI sessions also begin with no manually /skill-loaded instructions.
      // Bootstrap/discovery and task-driven skill calls remain in the shared loop.
      activeSkills: async () => [],
      publish: (sessionId, type, data) => sessionEventBus.publish(sessionId, type, data),
    }),
    project: (sessionId, entry) =>
      sessionEventBus.publishObserverEntry(sessionId, entry as ObserverEntry),
    register: (sessionId, path) => {
      sessionEventBus.clearReplay(sessionId);
      sessionEventBus.registerLedgerPath(sessionId, path);
    },
  });
  const run = runner.run.bind(runner);
  runner.run = async (message, options) => {
    try {
      return await run(message, options);
    } finally {
      const config = options?.config;
      const sessionId = config?.inkSessionId;
      if (sessionId && getActiveRun(sessionId)?.turnEpoch === config.turnEpoch) {
        sessionEventBus.clearReplay(sessionId);
        sessionEventBus.releaseObserverSession(sessionId);
      }
    }
  };
  return runner;
}
