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
import agentTriggerRouter, { getAgentGateway } from '../routes/agent-trigger';
import { createChatRouter } from '../routes/chat';
import {
  ChannelGateway,
  createChannelGateway,
  type ChannelGatewayConfig,
  type IncomingMessageHandler,
} from '../channels/gateway';
import { runWithRequestContext } from '../utils/request-context';
import { PcpAuthProvider } from './auth/pcp-auth-provider';

export { setWhatsAppListener, getAgentGateway };

export interface MCPServerConfig {
  /** Channel gateway configuration */
  channelGateway?: ChannelGatewayConfig;
  /** Handler for incoming messages from channels */
  messageHandler?: IncomingMessageHandler;
  /** Getter for the session service (for chat routes) */
  getSessionService?: () => import('../services/sessions/session-service').SessionService | null;
}

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
   * Create a new McpServer instance with all tools registered.
   * Each HTTP client session gets its own instance.
   */
  private createMcpServerInstance(): McpServer {
    const server = new McpServer({
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      description: MCP_SERVER_DESCRIPTION,
    });

    // Register all tools on this server instance
    registerAllTools(server, this.dataComposer);
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
    // Handles: POST (tool calls + initialize), DELETE (no-op)
    // ============================================================================
    app.post('/mcp', async (req, res) => {
      const authHeader = req.headers.authorization;
      const userData = await this.authProvider.verifyAccessToken(authHeader);

      // OAuth challenge for MCP clients (e.g. Gemini) when auth is required.
      const isMissingAuth = !authHeader;
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
      const ctx = userData ? { userId: userData.userId, email: userData.email } : {};

      await runWithRequestContext(ctx, async () => {
        let transport: StreamableHTTPServerTransport | undefined;
        let mcpServer: ReturnType<typeof this.createMcpServerInstance> | undefined;
        try {
          // Stateless: fresh transport per request — no session IDs, no stale sessions
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          mcpServer = this.createMcpServerInstance();

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
      const { client_id, redirect_uri, state, code_challenge, response_type } = req.query;

      logger.info('MCP /authorize called', { client_id, redirect_uri, state, response_type });

      if (response_type !== 'code') {
        res.status(400).json({ error: 'unsupported_response_type' });
        return;
      }

      const pendingId = this.authProvider.createPendingAuth({
        clientId: client_id as string,
        codeChallenge: code_challenge as string,
        redirectUri: redirect_uri as string,
        state: state as string,
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

    app.use('/api/agent', agentTriggerRouter);
    logger.info('Agent trigger routes registered at /api/agent');

    if (this.config.getSessionService) {
      const chatRouter = createChatRouter(this.config.getSessionService);
      app.use('/api/chat', chatRouter);
      logger.info('Chat API routes registered at /api/chat');
    }

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
    this.httpServer = app.listen(port, () => {
      logger.info(`MCP Server started with Streamable HTTP transport on port ${port}`);
      logger.info(`MCP endpoint: http://localhost:${port}/mcp`);
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
      this.httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
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
