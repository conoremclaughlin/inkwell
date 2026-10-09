/** Concrete authenticated server ports for the extracted composition, no CLI subprocess. */
import { createHostedMcpClient } from '@inklabs/shared/node-host';
import { encodeContextToken, buildCleanEnv } from '@inklabs/shared';
import { isAbsolute } from 'path';
import {
  verifyInkAccessToken,
  signInkAccessToken,
  type InkTokenPayload,
} from '../../auth/ink-tokens';
import { getActiveRun, isGenerationAdmitted, attachRunControls } from './active-runs';
import { createHostedInkExecutor, type PrepareHostedInkEffects } from './hosted-ink-executor';
import { HostedInkSessionRunner } from './hosted-ink-session';
import {
  createServerBackendHost,
  startHostedBackendTurn,
  HostedSpawnRefusal,
  type ServerBackendHostInput,
} from './server-backend-host';
import { openHostedInkLog } from './hosted-ink-log';
import type { BackendRunRequest } from '@inklabs/shared/providers';

export interface HostedInkBinding {
  /** Captured at host startup; never a session's inferred process environment. */
  baseEnv: Readonly<NodeJS.ProcessEnv>;
  paths: ServerBackendHostInput['paths'];
  mcpUrl: string;
  resolveBinary: ServerBackendHostInput['resolveBinary'];
  claudeSupportsPartialMessages: ServerBackendHostInput['claudeSupportsPartialMessages'];
  skillMcpServers: ServerBackendHostInput['skillMcpServers'];
  warn: ServerBackendHostInput['warn'];
  prepareEffects: PrepareHostedInkEffects;
  project(sessionId: string, entry: Record<string, unknown>): void;
  register(sessionId: string, path: string): void;
  /** Acceptance fixtures supply an owned store, never the shared live process table. */
  reserveLaunch?: ServerBackendHostInput['reserveLaunch'];
}

export function createBoundHostedInkRunner(input: HostedInkBinding) {
  const inherited = buildCleanEnv({}, { ...input.baseEnv });
  delete inherited.INK_TOOL_POLICY_PATH;
  delete inherited.INK_PORT_BASE;
  const baseEnv = Object.freeze({
    ...inherited,
    INK_SERVER_URL: new URL(input.mcpUrl).origin,
    INK_MCP_URL: new URL(input.mcpUrl).href,
  });
  const paths = Object.freeze({ ...input.paths });
  const mcpUrl = new URL(input.mcpUrl).href;
  return new HostedInkSessionRunner({
    execute: createHostedInkExecutor(input.prepareEffects),
    forTurn: async ({ sessionId, turnEpoch, config }) => {
      if (!config.sbSlug || !config.workingDirectory || !isAbsolute(config.workingDirectory))
        throw new Error('Hosted execution requires a named agent and absolute working directory');
      if (config.toolRouting === 'backend')
        throw new Error('Hosted backend tool routing awaits explicit MCP endpoint delivery');
      if (config.container || config.permissionOverlay || config.launchPermissions)
        throw new Error('Hosted execution cannot yet enforce this launch permission boundary');
      if (config.inkMcpUrl && new URL(config.inkMcpUrl).href !== mcpUrl)
        throw new Error('Hosted execution cannot redirect its authenticated Inkwell server');
      const token =
        config.inkAccessToken && verifyInkAccessToken(config.inkAccessToken, 'mcp_access');
      if (!token || token.sessionId !== sessionId || token.sbSlug !== config.sbSlug || !token.exp)
        throw new Error('Hosted execution requires its own session-bound access token');
      // Select only signed claims; do not spread iat or arbitrary JWT fields into a new token.
      const claims: InkTokenPayload = {
        type: 'mcp_access',
        sub: token.sub,
        email: token.email,
        scope: token.scope,
        sbSlug: token.sbSlug,
        sbId: token.sbId,
        identityId: token.identityId,
        sessionId: token.sessionId,
        contactId: token.contactId,
        exp: token.exp,
      };
      const admitted = () => {
        config.signal?.throwIfAborted();
        if (!isGenerationAdmitted(sessionId, turnEpoch))
          throw new HostedSpawnRefusal('Hosted generation is no longer admitted');
        const refusal = config.admitSpawn?.();
        if (refusal !== undefined) throw new HostedSpawnRefusal(refusal);
      };
      admitted();
      const run = getActiveRun(sessionId)!;
      if (
        run.userId !== claims.sub ||
        run.sbSlug !== config.sbSlug ||
        !claims.scope.split(/\s+/).includes('mcp:tools')
      )
        throw new Error('Hosted credential does not belong to this admitted run');
      const budgetMs = config.timeoutMs ?? 30 * 60_000;
      const deadlineAt = run.startedAt + budgetMs;
      const mintAccessToken = ({ ttlSeconds }: { ttlSeconds: number }) => {
        admitted();
        if (Date.now() >= deadlineAt || claims.exp! * 1000 <= Date.now())
          throw new HostedSpawnRefusal('Hosted credentials or run have expired');
        return signInkAccessToken(claims, ttlSeconds);
      };
      const hostInput: ServerBackendHostInput = {
        admission: { sessionId, turnEpoch },
        budgetMs,
        baseEnv: {
          ...baseEnv,
          ...(config.executionTier === 'tools' && config.toolPolicyPath
            ? { INK_TOOL_POLICY_PATH: config.toolPolicyPath }
            : {}),
        },
        paths,
        inkwellMcpUrl: mcpUrl,
        mintAccessToken,
        delegationSecret: config.inkDelegationSecret,
        resolveBinary: input.resolveBinary,
        claudeSupportsPartialMessages: input.claudeSupportsPartialMessages,
        skillMcpServers: input.skillMcpServers,
        warn: input.warn,
        admitSpawn: config.admitSpawn,
        reserveLaunch: input.reserveLaunch,
      };
      const host = createServerBackendHost(hostInput);
      const context = encodeContextToken({
        sessionId,
        sbSlug: config.sbSlug,
        studioId: config.studioId ?? 'main',
        cliAttached: false,
        runtime: 'ink',
        repoRoot: config.repoRoot,
      });
      const inkwell = createHostedMcpClient({
        url: mcpUrl,
        context,
        accessToken: () =>
          mintAccessToken({ ttlSeconds: Math.ceil((deadlineAt - Date.now()) / 1000) }),
      });
      const sessionLog = await openHostedInkLog({
        cwd: config.workingDirectory,
        signal: config.signal,
        sessionId,
        project: (entry) => input.project(sessionId, entry),
        register: (path) => input.register(sessionId, path),
      });
      admitted();
      return {
        deadlineAt,
        controls: {
          assertCurrent: admitted,
          bind: (enqueue) => {
            admitted();
            return attachRunControls(sessionId, turnEpoch, enqueue);
          },
        },
        inkwell,
        sessionLog,
        isHostedRefusal: (error) => error instanceof HostedSpawnRefusal,
        providerContext: {
          workingDirectory: config.workingDirectory,
          inkSessionId: sessionId,
          studioId: config.studioId,
          host,
        },
        startProviderTurn: (request) => {
          admitted();
          if (
            request.workingDirectory !== config.workingDirectory ||
            request.studioId !== config.studioId ||
            request.sbSlug !== config.sbSlug ||
            request.cliAttached !== false
          )
            throw new HostedSpawnRefusal('Provider launch changed the admitted session context');
          return startHostedBackendTurn(hostInput, {
            ...request,
            withholdProviderTools:
              config.executionTier === 'tools' || request.withholdProviderTools === true,
          } as Omit<BackendRunRequest, 'host'>).handle;
        },
      };
    },
  });
}
