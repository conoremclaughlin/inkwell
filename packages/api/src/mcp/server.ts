import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import type { Server } from 'http';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION, MCP_SERVER_DESCRIPTION } from '../config/constants';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { DataComposer } from '../data/composer';
import {
  registerAllTools,
  setMiniAppsRegistry,
  setTelegramListener,
  registerChannelListener,
} from './tools';
import {
  loadMiniApps,
  registerMiniAppTools,
  getMiniAppsInfo,
  type LoadedMiniApp,
} from '../mini-apps';
import adminRouter, { setWhatsAppListener } from '../routes/admin';
import { getAgentGateway } from '../channels/agent-gateway';
import { createChatRouter } from '../routes/chat';
import { createSessionsRouter } from '../routes/sessions';
import { sessionEventBus } from '../services/sessions/session-event-bus';
import { createHookLifecycleRouter } from '../routes/hook-lifecycle';
import {
  ChannelGateway,
  createChannelGateway,
  type ChannelGatewayConfig,
  type IncomingMessageHandler,
} from '../channels/gateway';
import { runWithRequestContext } from '../utils/request-context';
import { resolveWorkspaceContextForRequest } from '../utils/workspace-scope';
import { getRuntimeBuildInfo } from '../utils/runtime-build-info';
import { PcpAuthProvider } from './auth/pcp-auth-provider';
import { signPcpAccessToken } from '../auth/pcp-tokens';

export { setWhatsAppListener, getAgentGateway };

export interface MCPServerConfig {
  /** Channel gateway configuration */
  channelGateway?: ChannelGatewayConfig;
  /** Handler for incoming messages from channels */
  messageHandler?: IncomingMessageHandler;
  /** Getter for the session service (for chat routes) */
  getSessionService?: () => import('../services/sessions/session-service').SessionService | null;
}

const DELEGATED_ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60; // 1 hour

export class MCPServer {
  /** Primary server instance (used for stdio transport only) */
  private server: McpServer;
  private dataComposer: DataComposer;
  private httpServer: Server | null = null;

  private miniApps: Map<string, LoadedMiniApp> = new Map();
  private miniAppsInfo: Array<{
    name: string;
    version: string;
    description: string;
    triggers: string[];
    functions: string[];
  }> = [];
  private toolsVersion = 0;
  private channelGateway: ChannelGateway | null = null;
  private config: MCPServerConfig;
  private authProvider: PcpAuthProvider;

  constructor(dataComposer: DataComposer, config: MCPServerConfig = {}) {
    this.dataComposer = dataComposer;
    this.config = config;
    this.authProvider = new PcpAuthProvider();

    // Load mini-apps once (shared across all sessions)
    this.miniApps = loadMiniApps();
    setMiniAppsRegistry(this.miniApps);
    this.miniAppsInfo = getMiniAppsInfo(this.miniApps);
    logger.info(`Mini-apps loaded: ${this.miniAppsInfo.map((a) => a.name).join(', ') || 'none'}`);

    // Create primary server instance (used for stdio; HTTP creates per-session servers)
    this.server = this.createMcpServerInstance();

    logger.info('MCP Server initialized');
  }

  /**
   * Validate a context token by verifying the sessionId against the database.
   * The session was created via an authenticated start_session call, so a
   * matching active session proves the caller owns the identity. We also
   * verify the agentId matches to prevent session-id reuse across agents.
   */
  private async resolveUserFromContextSession(
    sessionId: string,
    agentId: string
  ): Promise<{ userId: string; email: string; agentId: string; sbId: string } | null> {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(sessionId)) {
      logger.debug('Context-based auth: malformed sessionId', { sessionId });
      return null;
    }

    let session;
    try {
      session = await this.dataComposer.repositories.memory.getSession(sessionId);
    } catch (error) {
      logger.debug('Context-based auth: session lookup failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!session) {
      logger.debug('Context-based auth: session not found', { sessionId });
      return null;
    }

    if (session.endedAt) {
      logger.debug('Context-based auth: session already ended', { sessionId });
      return null;
    }

    if (session.agentId !== agentId) {
      logger.warn('Context-based auth: agentId mismatch', {
        sessionId,
        sessionAgentId: session.agentId,
        contextAgentId: agentId,
      });
      return null;
    }

    // Canonical-first: the session row stores its owning identity UUID
    // (sessions.sb_id). Resolving by that UUID is unambiguous where the slug
    // is not — the same agent_id can exist in multiple workspaces, and a
    // slug .single() lookup errors on duplicates, breaking enrichment and
    // artifact writes for exactly the identities that need disambiguation
    // (PR #468 review 4902919349). Slug lookup remains only as the fallback
    // for legacy sessions without sb_id.
    if (session.sbId) {
      const { data, error } = await this.dataComposer
        .getClient()
        .from('agent_identities')
        .select('id, agent_id, user_id, users!inner(email)')
        .eq('id', session.sbId)
        .single();

      if (error || !data) {
        logger.debug('Context-based auth: session sb_id has no identity row', {
          sbId: session.sbId,
          sessionId,
        });
        return null;
      }
      if (data.user_id !== session.userId || data.agent_id !== agentId) {
        logger.warn('Context-based auth: session sb_id does not match session user/agent', {
          sessionId,
          sbId: session.sbId,
          identityUserId: data.user_id,
          sessionUserId: session.userId,
          identityAgentId: data.agent_id,
          contextAgentId: agentId,
        });
        return null;
      }
      const email = (data.users as unknown as { email: string })?.email ?? '';
      return { userId: session.userId, email, agentId, sbId: data.id };
    }

    const { data, error } = await this.dataComposer
      .getClient()
      .from('agent_identities')
      .select('id, user_id, users!inner(email)')
      .eq('agent_id', agentId)
      .eq('user_id', session.userId)
      .single();

    if (error || !data) {
      logger.debug('Context-based auth: no identity found for session user+agent', {
        agentId,
        userId: session.userId,
      });
      return null;
    }

    const email = (data.users as unknown as { email: string })?.email ?? '';
    return {
      userId: session.userId,
      email,
      agentId,
      sbId: data.id,
    };
  }

  /**
   * Canonical workspace derivation: one identity UUID → its workspace.
   * Preferred over the slug variant whenever sbId is known — the slug can
   * match identities in multiple workspaces (ambiguous by schema).
   */
  private async deriveWorkspaceIdFromSbId(sbId: string): Promise<string | null> {
    const { data, error } = await this.dataComposer
      .getClient()
      .from('agent_identities')
      .select('workspace_id')
      .eq('id', sbId)
      .maybeSingle();

    if (error) {
      logger.warn('Failed to derive workspace from identity UUID in MCP request context', {
        sbId,
        error: error.message,
      });
      return null;
    }
    return data?.workspace_id ?? null;
  }

  /**
   * Session-anchored identity enrichment. The normal local auth shape is an
   * unbound USER bearer (~/.ink/auth.json) with no agent claim, while the
   * x-ink-context token names the session's agent. The token alone is a
   * client assertion, so identity is enriched only when the referenced
   * session row (server truth) is live, matches the claimed agent, AND is
   * owned by the AUTHENTICATED user. Without this, ink-routed tool calls run
   * agent-less: workspace derivation for writes cannot run and
   * create_artifact fails wanting workspace scope (found live by Myra).
   */
  private async enrichIdentityFromContextSession(
    userData: { userId: string; email: string; agentId?: string; sbId?: string } | null,
    contextToken: { sessionId?: string; agentId?: string } | null
  ): Promise<{ userId: string; email: string; agentId?: string; sbId?: string } | null> {
    if (!userData) return userData;
    if (userData.agentId || !contextToken?.sessionId || !contextToken?.agentId) return userData;

    const sessionIdentity = await this.resolveUserFromContextSession(
      contextToken.sessionId,
      contextToken.agentId
    );
    if (!sessionIdentity) return userData;
    if (sessionIdentity.userId !== userData.userId) {
      logger.warn('Context session enrichment rejected: session owned by different user', {
        sessionId: contextToken.sessionId,
        sessionUserId: sessionIdentity.userId,
        authenticatedUserId: userData.userId,
      });
      return userData;
    }

    logger.debug('Context session enrichment: agent identity attached to user-token request', {
      sessionId: contextToken.sessionId,
      agentId: sessionIdentity.agentId,
      sbId: sessionIdentity.sbId,
      userId: userData.userId,
    });
    return { ...userData, agentId: sessionIdentity.agentId, sbId: sessionIdentity.sbId };
  }

  private async deriveWorkspaceIdFromAgent(
    userId: string,
    agentId: string
  ): Promise<string | null> {
    // TODO(lumen): Deduplicate this with the artifact-handler variant in a
    // shared helper that can choose ambiguous-workspace behavior (warn/throw).
    const { data, error } = await this.dataComposer
      .getClient()
      .from('agent_identities')
      .select('workspace_id')
      .eq('user_id', userId)
      .eq('agent_id', agentId);

    if (error) {
      logger.warn('Failed to derive workspace from agent identity in MCP request context', {
        userId,
        agentId,
        error: error.message,
      });
      return null;
    }

    const workspaceIds = Array.from(
      new Set(
        (data || [])
          .map((row) => row.workspace_id)
          .filter((workspaceId): workspaceId is string => typeof workspaceId === 'string')
      )
    );

    if (workspaceIds.length === 1) return workspaceIds[0];

    if (workspaceIds.length > 1) {
      logger.warn('Ambiguous workspace mapping for agent identity in MCP request context', {
        userId,
        agentId,
        workspaceCount: workspaceIds.length,
      });
    }

    return null;
  }

  private async resolveWorkspaceContextForMcpRequest(
    req: express.Request,
    userData: { userId: string; email: string; agentId?: string; sbId?: string }
  ): Promise<{ workspaceId?: string; workspaceSource?: 'header' | 'derived' }> {
    const requestedWorkspaceId = req.header('x-ink-workspace-id')?.trim();

    const resolution = await resolveWorkspaceContextForRequest({
      requestedWorkspaceId,
      validateRequestedWorkspaceId: requestedWorkspaceId
        ? async (workspaceId: string) => {
            const workspace = await this.dataComposer.repositories.workspaces.findById(
              workspaceId,
              userData.userId
            );
            return !!workspace;
          }
        : undefined,
      // Canonical UUID derivation first — the slug variant is ambiguous when
      // the same agent_id exists in multiple workspaces.
      deriveWorkspaceIdFromAgent: userData.sbId
        ? () => this.deriveWorkspaceIdFromSbId(userData.sbId!)
        : userData.agentId
          ? () => this.deriveWorkspaceIdFromAgent(userData.userId, userData.agentId!)
          : undefined,
    });

    if (!resolution) return {};

    return {
      workspaceId: resolution.workspaceId,
      workspaceSource: resolution.source,
    };
  }

  /**
   * Create a new McpServer instance with all tools registered.
   * Each HTTP client session gets its own instance.
   */
  private createMcpServerInstance(callerProfile: 'agent' | 'runtime' = 'agent'): McpServer {
    const server = new McpServer({
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      description: MCP_SERVER_DESCRIPTION,
    });

    // Register all tools on this server instance
    registerAllTools(server, this.dataComposer, {
      includeInternalLifecycleTools: callerProfile === 'runtime',
    });
    registerMiniAppTools(server, this.miniApps);

    // Error handling
    server.server.onerror = (error) => {
      logger.error('MCP Server instance error:', error);
    };

    return server;
  }

  /**
   * Start the MCP server with the appropriate transport
   */
  async start(): Promise<void> {
    try {
      if (env.MCP_TRANSPORT === 'stdio') {
        await this.startStdio();
      } else if (env.MCP_TRANSPORT === 'http') {
        await this.startHttp();
      } else {
        throw new Error(`Unknown MCP transport: ${env.MCP_TRANSPORT}`);
      }
    } catch (error) {
      logger.error('Failed to start MCP server:', error);
      throw error;
    }
  }

  /**
   * Start with stdio transport (for local use with Claude Desktop)
   * Single-client: uses the primary server instance.
   */
  private async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('MCP Server started with stdio transport');
  }

  /**
   * Start with Streamable HTTP transport (multi-client)
   * Each connecting client gets its own McpServer + Transport pair.
   */
  private async startHttp(): Promise<void> {
    const port = env.MCP_HTTP_PORT;
    const baseUrl = env.MCP_BASE_URL || `http://localhost:${port}`;
    const app = express();

    // Enable CORS for web portal, MCP clients, and agents
    app.use(
      cors({
        origin: ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'],
        credentials: true,
      })
    );

    // ============================================================================
    // Streamable HTTP MCP endpoint (stateless)
    // Each request gets a fresh transport — no session tracking, no stale sessions.
    // Handles: POST (tool calls + initialize), GET (explicit 405 when no SSE stream
    // is offered), DELETE (no-op)
    // ============================================================================
    const handleMcpRequest = async (req: express.Request, res: express.Response) => {
      const authHeader = req.headers.authorization;
      let userData = await this.authProvider.verifyAccessToken(authHeader);

      // Parse x-ink-context early so we can use it for auth fallback.
      const contextHeader = req.header('x-ink-context')?.trim();
      let contextToken: import('@inklabs/shared').PcpContextToken | null = null;
      if (contextHeader) {
        const { decodeContextToken } = await import('@inklabs/shared');
        contextToken = decodeContextToken(contextHeader);
      }

      // Session-validated context auth: when NO Authorization header is present
      // but the request carries an x-ink-context with a sessionId + agentId,
      // verify the session exists and is active in the database. The session was
      // created through an authenticated start_session call, so a matching
      // active session proves the caller owns the identity.
      //
      // This is NOT attempted when an Authorization header IS present but
      // invalid — that's a hard auth failure, not a fallback scenario.
      if (!userData && !authHeader && contextToken?.sessionId && contextToken?.agentId) {
        userData = await this.resolveUserFromContextSession(
          contextToken.sessionId,
          contextToken.agentId
        );
        if (userData) {
          logger.debug('Context-based auth: resolved identity from verified session', {
            sessionId: contextToken.sessionId,
            agentId: contextToken.agentId,
            userId: userData.userId,
          });
        }
      }

      // OAuth challenge for MCP clients (e.g. Gemini) when auth is required.
      const isMissingAuth = !authHeader && !userData;
      const isInvalidAuth = !!authHeader && !userData;
      const shouldChallenge = isInvalidAuth || (env.MCP_REQUIRE_OAUTH && isMissingAuth);

      if (shouldChallenge) {
        const challengeParts = [
          'Bearer realm="pcp"',
          'scope="mcp:tools"',
          `authorization_uri="${baseUrl}/authorize"`,
          `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
        ];

        if (isInvalidAuth) {
          challengeParts.push('error="invalid_token"');
        }

        res
          .status(401)
          .set('WWW-Authenticate', challengeParts.join(', '))
          .json({
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: isInvalidAuth
                ? 'Invalid or expired access token'
                : 'Authentication required',
            },
            id: null,
          });
        return;
      }

      // Use request-scoped context (AsyncLocalStorage) instead of global state
      // to prevent identity leaking across concurrent stateless requests.
      const ctx = userData
        ? {
            userId: userData.userId,
            email: userData.email,
            agentId: userData.agentId,
            sbId: userData.sbId,
          }
        : {};

      // Session-anchored identity enrichment (see
      // enrichIdentityFromContextSession): attaches the session's agent
      // identity — canonical sbId first — to user-token requests so
      // pinned-agent dispatch and workspace derivation work for ink-routed
      // tool calls.
      // Snapshot the token's own identity before enrichment. Authorization
      // reads these; everything below may be overwritten by session-derived
      // values that are routing hints, not authentication facts.
      if (userData?.agentId || userData?.sbId) {
        Object.assign(ctx, {
          agentTokenBound: true,
          ...(userData.agentId ? { tokenAgentId: userData.agentId } : {}),
          ...(userData.sbId ? { tokenSbId: userData.sbId } : {}),
        });
      }

      const effectiveIdentity = await this.enrichIdentityFromContextSession(userData, contextToken);
      if (effectiveIdentity && effectiveIdentity !== userData) {
        Object.assign(ctx, {
          agentId: effectiveIdentity.agentId,
          sbId: effectiveIdentity.sbId,
        });
      }
      const callerProfileHeader = req.header('x-ink-caller-profile')?.trim().toLowerCase();
      const callerProfile: 'agent' | 'runtime' =
        callerProfileHeader === 'runtime' ? 'runtime' : 'agent';
      const sessionIdHeader = contextToken?.sessionId || req.header('x-ink-session-id')?.trim();
      // ── Studio scope (worktree-level) ──
      // studioId and workspaceId are DIFFERENT concepts. Never conflate them.
      // studioId = worktree/git scope. workspaceId = parent container for all docs/SBs.
      const studioIdHeader = contextToken?.studioId || req.header('x-ink-studio-id')?.trim();
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const studioIdIsUuid = studioIdHeader && UUID_RE.test(studioIdHeader);
      Object.assign(ctx, {
        callerProfile,
        ...(sessionIdHeader ? { sessionId: sessionIdHeader } : {}),
        ...(studioIdIsUuid ? { studioId: studioIdHeader } : {}),
        ...(studioIdHeader && !studioIdIsUuid ? { studioHint: studioIdHeader } : {}),
        ...(contextToken?.cliAttached ? { cliAttached: true } : {}),
        ...(contextToken?.runtime ? { runtime: contextToken.runtime } : {}),
        ...(contextToken?.repoRoot ? { repoRoot: contextToken.repoRoot } : {}),
      });

      // Resolve studioId from session when x-ink-session-id is provided
      // but x-ink-studio-id is not. The session record stores its studio scope.
      if (sessionIdHeader && !studioIdHeader && userData) {
        try {
          const session = await this.dataComposer.repositories.memory.getSession(sessionIdHeader);
          if (session?.studioId) {
            if (session.userId !== userData.userId) {
              logger.warn('Session-derived studioId rejected: session belongs to different user', {
                sessionId: sessionIdHeader,
                sessionUserId: session.userId,
                authenticatedUserId: userData.userId,
              });
            } else {
              Object.assign(ctx, { studioId: session.studioId });
            }
          }
        } catch (error) {
          logger.debug('Failed to resolve studioId from session header', {
            sessionId: sessionIdHeader,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // ── Workspace scope (parent-level) ──
      // Always resolve workspace independently — it's a different scope than
      // studio. Uses the session-enriched identity so agent-derived workspace
      // resolution works for user-token requests too.
      if (effectiveIdentity) {
        try {
          Object.assign(
            ctx,
            await this.resolveWorkspaceContextForMcpRequest(req, effectiveIdentity)
          );
        } catch (error) {
          logger.warn('Rejected MCP request due to invalid workspace scope', {
            userId: effectiveIdentity.userId,
            agentId: effectiveIdentity.agentId,
            error: error instanceof Error ? error.message : String(error),
          });
          res.status(403).json({
            jsonrpc: '2.0',
            error: { code: -32003, message: 'Workspace not found or not accessible.' },
            id: null,
          });
          return;
        }
      }

      await runWithRequestContext(ctx, async () => {
        let transport: StreamableHTTPServerTransport | undefined;
        let mcpServer: ReturnType<typeof this.createMcpServerInstance> | undefined;
        try {
          // Stateless: fresh transport per request — no session IDs, no stale sessions
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          mcpServer = this.createMcpServerInstance(callerProfile);

          await mcpServer.connect(transport);
          await transport.handleRequest(req, res);
        } catch (error) {
          logger.error('Error handling MCP request:', error);
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            });
          }
        } finally {
          if (transport) transport.onclose = undefined;
          if (mcpServer) {
            mcpServer.close().catch((err) => {
              logger.debug('Error closing stateless MCP server instance', { error: err });
            });
          }
        }
      });
    };

    app.post('/mcp', handleMcpRequest);

    // This stateless endpoint does not expose a standalone SSE stream.
    // Streamable HTTP clients may probe GET /mcp; return explicit 405 per spec.
    app.get('/mcp', (_req, res) => {
      res
        .status(405)
        .set('Allow', 'POST, DELETE')
        .json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        });
    });

    // DELETE /mcp - No-op in stateless mode (no sessions to terminate)
    app.delete('/mcp', async (_req, res) => {
      res.status(204).end();
    });

    // ============================================================================
    // Health check
    // ============================================================================
    app.get('/health', async (_req, res) => {
      const startTime = Date.now();
      const checks: Record<
        string,
        { status: 'ok' | 'error'; latencyMs?: number; error?: string; details?: unknown }
      > = {};

      try {
        const dbStart = Date.now();
        const { error } = await this.dataComposer.getClient().from('users').select('id').limit(1);
        checks.database = error
          ? { status: 'error', error: error.message }
          : { status: 'ok', latencyMs: Date.now() - dbStart };
      } catch (err) {
        checks.database = {
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }

      if (this.channelGateway) {
        const gatewayStatus = this.channelGateway.getStatus();
        checks.telegram = {
          status:
            gatewayStatus.telegram.enabled && gatewayStatus.telegram.connected ? 'ok' : 'error',
          ...(gatewayStatus.telegram.enabled &&
            !gatewayStatus.telegram.connected && { error: 'Not connected' }),
          ...(!gatewayStatus.telegram.enabled && { error: 'Disabled' }),
        };
        checks.whatsapp = {
          status:
            gatewayStatus.whatsapp.enabled && gatewayStatus.whatsapp.connected ? 'ok' : 'error',
          ...(gatewayStatus.whatsapp.enabled &&
            !gatewayStatus.whatsapp.connected && { error: 'Not connected' }),
          ...(!gatewayStatus.whatsapp.enabled && { error: 'Disabled' }),
        };
        checks.discord = {
          status: gatewayStatus.discord.enabled && gatewayStatus.discord.connected ? 'ok' : 'error',
          ...(gatewayStatus.discord.enabled &&
            !gatewayStatus.discord.connected && { error: 'Not connected' }),
          ...(!gatewayStatus.discord.enabled && { error: 'Disabled' }),
        };
      }

      checks.mcp = {
        status: 'ok',
        details: {
          mode: 'stateless',
          toolsVersion: this.toolsVersion,
          miniApps: this.miniAppsInfo.map((m) => m.name),
        },
      };

      const dbOk = checks.database?.status === 'ok';
      const overallStatus = dbOk ? 'healthy' : 'unhealthy';

      res.status(dbOk ? 200 : 503).json({
        status: overallStatus,
        version: MCP_SERVER_VERSION,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        latencyMs: Date.now() - startTime,
        build: getRuntimeBuildInfo(),
        checks,
      });
    });

    // ============================================================================
    // OAuth 2.0 endpoints for MCP authentication
    // ============================================================================

    // Dynamic client registration (RFC 7591)
    app.post('/register', express.json(), (req, res) => {
      logger.info('MCP /register called', { body: req.body });

      const clientId = req.body.client_id || `pcp-client-${Date.now()}`;

      res.json({
        client_id: clientId,
        client_secret: 'pcp-local-secret',
        redirect_uris: req.body.redirect_uris || ['http://localhost:3001/callback'],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: req.body.client_name || 'Claude Code MCP Client',
        scope: 'mcp:tools',
      });
    });

    // Authorization endpoint — redirects to web portal for login
    app.get('/authorize', (req, res) => {
      const { client_id, redirect_uri, state, code_challenge, response_type, agent_id } = req.query;

      logger.info('MCP /authorize called', {
        client_id,
        redirect_uri,
        state,
        response_type,
        agent_id,
      });

      if (response_type !== 'code') {
        res.status(400).json({ error: 'unsupported_response_type' });
        return;
      }

      const pendingId = this.authProvider.createPendingAuth({
        clientId: client_id as string,
        codeChallenge: code_challenge as string,
        redirectUri: redirect_uri as string,
        state: state as string,
        agentId: agent_id as string | undefined,
      });

      const webPortalUrl = process.env.WEB_PORTAL_URL || 'http://localhost:3002';

      const loginUrl = new URL(`${webPortalUrl}/login`);
      loginUrl.searchParams.set('pending_id', pendingId);

      logger.info('MCP /authorize redirecting to web portal', {
        pendingId,
        loginUrl: loginUrl.toString(),
      });
      res.redirect(loginUrl.toString());
    });

    // Auth callback — receives Supabase access token from web portal, creates auth code
    app.get('/mcp/auth/callback', async (req, res) => {
      const pendingId = req.query.pending_id as string;
      const accessToken = req.query.access_token as string;

      logger.info('MCP /mcp/auth/callback called', {
        pendingId,
        hasAccessToken: !!accessToken,
      });

      if (!accessToken) {
        res.status(400).send('Missing access token. Please try logging in again.');
        return;
      }

      const result = await this.authProvider.handleAuthCallback({
        pendingId,
        accessToken,
      });

      if ('error' in result) {
        const statusCode =
          result.error === 'server_error' ? 500 : result.error === 'access_denied' ? 403 : 400;
        res.status(statusCode).send(result.error_description || result.error);
        return;
      }

      const redirectUrl = new URL(result.redirectUri);
      redirectUrl.searchParams.set('code', result.code);
      if (result.state) {
        redirectUrl.searchParams.set('state', result.state);
      }

      logger.info('MCP auth complete, redirecting to client');
      res.redirect(redirectUrl.toString());
    });

    // Token endpoint — handles authorization_code and refresh_token grants
    app.post('/token', express.urlencoded({ extended: true }), async (req, res) => {
      const { grant_type, code, code_verifier, client_id, refresh_token } = req.body;

      logger.info('MCP /token called', {
        grant_type,
        client_id,
        hasCode: !!code,
        hasVerifier: !!code_verifier,
        hasRefreshToken: !!refresh_token,
      });

      if (grant_type === 'authorization_code') {
        const result = await this.authProvider.exchangeAuthorizationCode({
          code,
          codeVerifier: code_verifier,
          clientId: client_id,
        });

        if ('error' in result) {
          res.status(400).json(result);
          return;
        }

        res.json(result);
      } else if (grant_type === 'refresh_token') {
        if (!refresh_token) {
          res.status(400).json({
            error: 'invalid_request',
            error_description: 'Missing refresh_token parameter',
          });
          return;
        }

        const result = await this.authProvider.exchangeRefreshToken({
          refreshToken: refresh_token,
          clientId: client_id,
        });

        if ('error' in result) {
          res.status(400).json(result);
          return;
        }

        res.json(result);
      } else {
        res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: `Grant type '${grant_type}' is not supported`,
        });
      }
    });

    // Delegated token endpoint — mint short-lived agent-bound MCP access tokens.
    app.post('/token/delegate', express.json(), async (req, res) => {
      const authHeader = req.header('authorization');
      const userData = await this.authProvider.verifyAccessToken(authHeader);
      if (!userData) {
        res.status(401).json({
          error: 'invalid_token',
          error_description: 'Missing or invalid bearer token',
        });
        return;
      }

      const requestedAgentId =
        typeof req.body?.agentId === 'string' ? req.body.agentId.trim().toLowerCase() : '';
      if (!requestedAgentId) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing required field: agentId',
        });
        return;
      }

      const { data: identity, error: identityError } = await this.dataComposer
        .getClient()
        .from('agent_identities')
        .select('id, agent_id')
        .eq('user_id', userData.userId)
        .eq('agent_id', requestedAgentId)
        .maybeSingle();

      if (identityError) {
        logger.error('Failed to resolve agent identity for delegated token', {
          userId: userData.userId,
          requestedAgentId,
          error: identityError.message,
        });
        res.status(500).json({
          error: 'server_error',
          error_description: 'Failed to resolve requested agent identity',
        });
        return;
      }

      if (!identity) {
        res.status(403).json({
          error: 'forbidden',
          error_description: 'Agent identity not found for this user',
        });
        return;
      }

      const accessToken = signPcpAccessToken(
        {
          type: 'mcp_access',
          sub: userData.userId,
          email: userData.email,
          scope: 'mcp:tools',
          agentId: identity.agent_id,
          identityId: identity.id,
        },
        DELEGATED_ACCESS_TOKEN_LIFETIME_SECONDS
      );

      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: DELEGATED_ACCESS_TOKEN_LIFETIME_SECONDS,
        scope: 'mcp:tools',
        delegated_agent_id: identity.agent_id,
        sb_id: identity.id,
      });
    });

    // OAuth Authorization Server Metadata (RFC 8414)
    app.get('/.well-known/oauth-authorization-server', (_req, res) => {
      res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        scopes_supported: ['mcp:tools'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      });
    });

    // OAuth Protected Resource Metadata (RFC 9728)
    app.get('/.well-known/oauth-protected-resource', (_req, res) => {
      res.json({
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp:tools'],
      });
    });

    // ============================================================================
    // Admin & Agent routes
    // ============================================================================
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin', adminRouter);
    logger.info('Admin API routes registered at /api/admin');

    const hookLifecycleRouter = createHookLifecycleRouter(this.dataComposer);
    app.use('/api/hooks', hookLifecycleRouter);
    logger.info('Hook lifecycle routes registered at /api/hooks');

    if (this.config.getSessionService) {
      const chatRouter = createChatRouter(this.config.getSessionService);
      app.use('/api/chat', chatRouter);
      logger.info('Chat API routes registered at /api/chat');
    }

    // Live session event stream (SSE) — attached terminals + dashboard subscribe
    // to a session's turn events, fanned out from the session event bus.
    // The durable ledger locator rides in the session row's metadata (no new
    // tables) so observer replay survives bus eviction and process restarts.
    const locatorClient = this.dataComposer.getClient();
    sessionEventBus.setLocatorStore({
      // Dedicated column, single-column UPDATE — no read-modify-write of the
      // shared metadata object (that merge raced other session updates and
      // could silently drop the locator). PostgREST reports failures via
      // `error`, not exceptions — check and THROW so the bus's retry/logging
      // actually sees them (Lumen re-review, blocker 1).
      persist: async (sessionId, ledgerPath) => {
        const { error } = await locatorClient
          .from('sessions')
          .update({ observer_ledger_path: ledgerPath })
          .eq('id', sessionId);
        if (error) {
          throw new Error(`locator persist failed: ${error.message}`);
        }
      },
      // activity: authoritative evidence for the vacuous-replay decision —
      // 'completed' (markers prove durable history), 'attempted' (turn
      // started, ledger may hold entries), 'none' (durably pristine idle).
      load: async (sessionId) => {
        const { data: row, error } = await locatorClient
          .from('sessions')
          .select(
            'observer_ledger_path, backend_session_id, token_count, message_count, lifecycle, ended_at'
          )
          .eq('id', sessionId)
          .maybeSingle();
        if (error) {
          throw new Error(`locator load failed: ${error.message}`);
        }
        // Completed markers are written only AFTER a turn returns; the ledger
        // gains entries at turn START. A started-but-never-completed turn
        // (lifecycle running/failed, or ended without markers) is therefore
        // 'attempted' — never proof of a pristine session (Lumen M4.4).
        const completed = Boolean(
          row &&
          (row.backend_session_id || (row.token_count ?? 0) > 0 || (row.message_count ?? 0) > 0)
        );
        const pristine =
          !row || ((row.lifecycle === null || row.lifecycle === 'idle') && !row.ended_at);
        return {
          ledgerPath: row?.observer_ledger_path ?? null,
          activity: completed
            ? ('completed' as const)
            : pristine
              ? ('none' as const)
              : ('attempted' as const),
        };
      },
    });
    const sessionsRouter = createSessionsRouter({
      authProvider: this.authProvider,
      dataComposer: this.dataComposer,
    });
    app.use('/api/sessions', sessionsRouter);
    logger.info('Session event routes registered at /api/sessions');

    // Kindle routes (registered below after import)
    import('../routes/kindle.js')
      .then(({ createKindleRouter }) => {
        const kindleRouter = createKindleRouter();
        app.use('/api/kindle', kindleRouter);
        logger.info('Kindle API routes registered at /api/kindle');
      })
      .catch((err) => {
        logger.warn('Kindle routes not loaded:', err.message);
      });

    app.post('/refresh-tools', async (_req, res) => {
      try {
        await this.notifyToolsChanged();
        res.json({
          success: true,
          message: 'Tools refresh notification sent',
          toolsVersion: this.toolsVersion,
        });
      } catch (error) {
        logger.error('Error refreshing tools:', error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // ============================================================================
    // Start listening
    // ============================================================================
    const host = process.env.NODE_ENV === 'test' ? '127.0.0.1' : '0.0.0.0';
    this.httpServer = await new Promise<Server>((resolve, reject) => {
      const server = app.listen(port, host, () => {
        logger.info(`MCP Server started with Streamable HTTP transport on ${host}:${port}`);
        logger.info(`MCP endpoint: http://localhost:${port}/mcp`);
        resolve(server);
      });

      server.on('error', (error) => {
        reject(error);
      });
    });

    // Periodic cleanup of expired MCP refresh tokens (every 6 hours)
    setInterval(
      () => {
        this.authProvider.cleanupExpiredDatabaseTokens();
      },
      6 * 60 * 60 * 1000
    );

    // Initialize channel gateway if message handler is configured
    if (this.config.messageHandler) {
      await this.startChannelGateway();
    } else {
      logger.info('ChannelGateway not started (no messageHandler configured)');
    }
  }

  /**
   * Initialize and start the channel gateway
   */
  private async startChannelGateway(): Promise<void> {
    logger.info('Initializing ChannelGateway...');

    this.channelGateway = createChannelGateway({
      ...this.config.channelGateway,
      dataComposer: this.dataComposer,
    });

    if (this.config.messageHandler) {
      this.channelGateway.setMessageHandler(this.config.messageHandler);
    }

    this.channelGateway.on('telegram:connected', () => {
      const listener = this.channelGateway?.getTelegramListener();
      if (listener) {
        setTelegramListener(listener);
        logger.info('Telegram listener registered with MCP tools');
      }
    });

    this.channelGateway.on('whatsapp:connected', () => {
      const listener = this.channelGateway?.getWhatsAppListener();
      if (listener) {
        setWhatsAppListener(listener);
        logger.info('WhatsApp listener registered with admin routes');
      }
    });

    this.channelGateway.on('discord:connected', () => {
      const listener = this.channelGateway?.getDiscordListener();
      if (listener) {
        registerChannelListener('discord', listener);
        logger.info('Discord listener registered with MCP tools');
      }
    });

    this.channelGateway.on('slack:connected', () => {
      const listener = this.channelGateway?.getSlackListener();
      if (listener) {
        registerChannelListener('slack', listener);
        logger.info('Slack listener registered with MCP tools');
      }
    });

    await this.channelGateway.start();

    const telegramListener = this.channelGateway.getTelegramListener();
    if (telegramListener) {
      setTelegramListener(telegramListener);
    }

    const whatsAppListener = this.channelGateway.getWhatsAppListener();
    if (whatsAppListener) {
      setWhatsAppListener(whatsAppListener);
    }

    const discordListener = this.channelGateway.getDiscordListener();
    if (discordListener) {
      registerChannelListener('discord', discordListener);
    }

    const slackListener = this.channelGateway.getSlackListener();
    if (slackListener) {
      registerChannelListener('slack', slackListener);
    }

    logger.info('ChannelGateway started', this.channelGateway.getStatus());
  }

  /**
   * Get the primary server instance (for stdio transport)
   */
  getServer(): McpServer {
    return this.server;
  }

  /**
   * Gracefully shutdown the server
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down MCP server...');

    // Stop channel gateway first
    if (this.channelGateway) {
      await this.channelGateway.stop();
      this.channelGateway = null;
    }

    // Close the primary server (stdio)
    try {
      await this.server.close();
    } catch (error) {
      logger.warn('Error closing primary MCP server:', error);
    }

    if (this.httpServer) {
      // Graceful close first — stop accepting new connections and wait for
      // in-flight requests to drain. Then force-kill any remaining sockets.
      // The parent shutdown() has a 10s force-kill timer as a safety net.
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer.closeAllConnections();
      this.httpServer = null;
    }

    logger.info('MCP server shut down');
  }

  getChannelGateway(): ChannelGateway | null {
    return this.channelGateway;
  }

  getPort(): number | null {
    if (this.httpServer) {
      const addr = this.httpServer.address();
      if (addr && typeof addr === 'object') {
        return addr.port;
      }
    }
    return null;
  }

  /**
   * Notify clients that tools have changed.
   * In stateless mode, each request gets a fresh server instance, so there are
   * no persistent sessions to notify. We just bump the version counter.
   */
  async notifyToolsChanged(): Promise<void> {
    this.toolsVersion++;
    logger.info(`Tools changed (version ${this.toolsVersion})`);
  }

  getToolsVersion(): number {
    return this.toolsVersion;
  }
}

export async function createMCPServer(
  dataComposer: DataComposer,
  config?: MCPServerConfig
): Promise<MCPServer> {
  return new MCPServer(dataComposer, config);
}

export { ChannelGateway, type ChannelGatewayConfig, type IncomingMessageHandler };
