/**
 * The BackendHost of a process that serves the session it runs in: `ink chat`
 * and the launchers (`ink claude`, awaken). It answers from this process's own
 * env, home and PATH, which is what the adapters did for themselves before
 * the host port existed, so a CLI spawn is prepared exactly as it was.
 *
 * A host serving other sessions (the API server) answers per session instead,
 * and never from its own env, cwd or home.
 */

import { execFileSync } from 'child_process';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { sessionEnvHandoff } from '@inklabs/shared';
import { discoverSkillMcpServers, type BackendHost } from '@inklabs/shared/providers';
import { getInkServerUrl } from '../lib/ink-mcp.js';

/**
 * Once-per-process probe for `--include-partial-messages` support. It runs in
 * the CLI process, never the API server, so a brief sync probe just before
 * spawning a multi-second backend turn is acceptable.
 */
let partialMessagesSupport: boolean | null = null;
function supportsPartialMessages(): boolean {
  if (partialMessagesSupport === null) {
    try {
      const help = execFileSync('claude', ['--help'], { encoding: 'utf-8', timeout: 5000 });
      partialMessagesSupport = help.includes('--include-partial-messages');
    } catch {
      partialMessagesSupport = false;
    }
  }
  return partialMessagesSupport;
}

export function createCliBackendHost(): BackendHost {
  return {
    // Read when asked, as the adapters read them, not when the host is made.
    paths: {
      get inkFiles() {
        return join(homedir(), '.ink', 'files');
      },
      get studiosRoot() {
        return process.env.INK_STUDIOS_ROOT || join(homedir(), '.ink', 'studios');
      },
      get tempDir() {
        return tmpdir();
      },
    },
    ambientSession: () => ({
      inkSessionId: process.env.INK_SESSION_ID,
      studioId: process.env.INK_STUDIO_ID,
    }),
    claudeSupportsPartialMessages: async () => supportsPartialMessages(),
    skillMcpServers: async (cwd) => discoverSkillMcpServers(cwd),
    // This process's own session credentials, handed over as they were before
    // the port. The spawn's deadline is not used: a CLI child still gets
    // whatever token this process holds, however long the turn runs.
    sessionEnv: async () => sessionEnvHandoff(),
    // The CLI host is its own session's process: the child inherits from it.
    baseEnv: async () => process.env,
    // The server this process talks to, read when asked. Only its origin is
    // compared.
    get inkwellMcpUrl() {
      return `${getInkServerUrl()}/mcp`;
    },
    // PATH lookup at spawn, as before.
    resolveBinary: async (name) => name,
    warn: (message) => console.warn(message),
  };
}
