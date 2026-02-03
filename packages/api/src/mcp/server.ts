import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import type { Server } from 'http';
import { createClient } from '@supabase/supabase-js';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../config/constants';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { DataComposer } from '../data/composer';
import { registerAllTools, setMiniAppsRegistry, setTelegramListener } from './tools';
import { loadMiniApps, registerMiniAppTools, getMiniAppsInfo } from '../mini-apps';
import adminRouter, { setWhatsAppListener } from '../routes/admin';
import agentTriggerRouter, { getAgentGateway } from '../routes/agent-trigger';
import { ChannelGateway, createChannelGateway, type ChannelGatewayConfig, type IncomingMessageHandler } from '../channels/gateway';
import { setSessionContext } from '../utils/request-context';

export { setWhatsAppListener, getAgentGateway };

export interface MCPServerConfig {
  /** Channel gateway configuration */
  channelGateway?: ChannelGatewayConfig;
  /** Handler for incoming messages from channels */
  messageHandler?: IncomingMessageHandler;
}

export class MCPServer {
  private server: McpServer;
  private dataComposer: DataComposer;
  private httpServer: Server | null = null;
  private sseTransport: SSEServerTransport | null = null;
  private miniAppsInfo: Array<{ name: string; version: string; description: string; triggers: string[]; functions: string[] }> = [];
  private toolsVersion = 0; // Incremented when tools change
  private channelGateway: ChannelGateway | null = null;
  private config: MCPServerConfig;

  constructor(dataComposer: DataComposer, config: MCPServerConfig = {}) {
    this.dataComposer = dataComposer;
    this.config = config;

    // Create MCP server instance using the high-level McpServer API
    this.server = new McpServer({
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    });

    // Register all tools
    this.registerTools();

    // Set up error handling on the underlying server
    this.server.server.onerror = (error) => {
      logger.error('MCP Server error:', error);
    };

    logger.info('MCP Server initialized');
  }

  /**
   * Register all MCP tools
   */
  private registerTools(): void {
    // Register core PCP tools
    registerAllTools(this.server, this.dataComposer);
    logger.info('Core MCP tools registered');

    // Load and register mini-app tools
    const miniApps = loadMiniApps();
    registerMiniAppTools(this.server, miniApps);

    // Register mini-apps with skill handlers so get_skill tool can access them
    setMiniAppsRegistry(miniApps);

    this.miniAppsInfo = getMiniAppsInfo(miniApps);
    logger.info(`Mini-apps loaded: ${this.miniAppsInfo.map(a => a.name).join(', ') || 'none'}`);
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
   */
  private async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('MCP Server started with stdio transport');
  }

  /**
   * Start with HTTP/SSE transport
   */
  private async startHttp(): Promise<void> {
    const port = env.MCP_HTTP_PORT;
    const app = express();

    // ============================================================================
    // Supabase JWT validation helper
    // Uses the same auth as /api/admin endpoints - one JWT for everything
    // ============================================================================
    const validateSupabaseToken = async (authHeader: string | undefined): Promise<{ userId: string; email: string } | null> => {
      if (!authHeader?.startsWith('Bearer ')) return null;
      const token = authHeader.substring(7);

      try {
        const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
          logger.debug('Supabase token validation failed', { error: error?.message });
          return null;
        }

        // Look up PCP user by email
        const { data: pcpUser } = await supabase
          .from('users')
          .select('id, email')
          .eq('email', user.email)
          .single();

        if (!pcpUser) {
          logger.warn('Supabase user not found in PCP', { email: user.email });
          return null;
        }

        return { userId: pcpUser.id, email: pcpUser.email };
      } catch (error) {
        logger.error('Error validating Supabase token', { error });
        return null;
      }
    };

    // Enable CORS for web portal, MCP clients, and Myra
    app.use(cors({
      origin: ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'],
      credentials: true,
    }));

    // SSE endpoint for MCP communication
    app.get('/sse', async (req, res) => {
      logger.info('SSE connection request received');

      // Validate Supabase JWT and set session context
      const userData = await validateSupabaseToken(req.headers.authorization);
      if (userData) {
        setSessionContext({
          userId: userData.userId,
          email: userData.email,
        });
        logger.info('SSE connection authenticated', {
          userId: userData.userId,
          email: userData.email,
        });
      } else {
        logger.warn('SSE connection without valid Supabase token');
      }

      this.sseTransport = new SSEServerTransport('/message', res);

      // Connect the transport to the MCP server
      // Note: connect() calls start() automatically on the transport
      await this.server.connect(this.sseTransport);

      logger.info('SSE transport connected', { sessionId: this.sseTransport.sessionId });
    });

    // Message endpoint for client-to-server messages
    // Note: Don't use express.json() here - handlePostMessage reads the raw body itself
    app.post('/message', async (req, res) => {
      if (!this.sseTransport) {
        res.status(503).json({ error: 'SSE transport not connected' });
        return;
      }

      try {
        await this.sseTransport.handlePostMessage(req, res);
      } catch (error) {
        logger.error('Error handling message:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Health check endpoint
    app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
        connected: this.sseTransport !== null,
        toolsVersion: this.toolsVersion,
        miniApps: this.miniAppsInfo,
      });
    });

    // ============================================================================
    // OAuth 2.0 endpoints for MCP authentication
    // Implements: Dynamic Client Registration, Authorization Code + PKCE flow
    // Uses Supabase Auth - returns Supabase JWT which is validated at /sse
    // ============================================================================

    // Store for OAuth state (in production, use Redis or similar)
    interface PendingAuth {
      clientId: string;
      codeChallenge: string;
      redirectUri: string;
      state: string;
      expiresAt: number;
    }
    interface AuthCode {
      clientId: string;
      codeChallenge: string;
      redirectUri: string;
      supabaseToken: string;  // The actual Supabase JWT to return
      userId: string;         // For logging
      userEmail: string;      // For logging
      expiresAt: number;
    }

    const pendingAuths = new Map<string, PendingAuth>();
    const oauthCodes = new Map<string, AuthCode>();

    // POST /register - OAuth 2.0 Dynamic Client Registration (RFC 7591)
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

    // GET /authorize - OAuth 2.0 Authorization Endpoint
    // Redirects to web portal login page (localhost:3002)
    app.get('/authorize', (req, res) => {
      const { client_id, redirect_uri, state, code_challenge, response_type } = req.query;

      logger.info('MCP /authorize called', {
        client_id,
        redirect_uri,
        state,
        response_type,
      });

      if (response_type !== 'code') {
        res.status(400).json({ error: 'unsupported_response_type' });
        return;
      }

      // Generate a pending auth ID to track this request
      const pendingId = `pending-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      // Store the pending auth request
      pendingAuths.set(pendingId, {
        clientId: client_id as string,
        codeChallenge: code_challenge as string,
        redirectUri: redirect_uri as string,
        state: state as string,
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
      });

      // Redirect to web portal login with callback to MCP
      const webPortalUrl = process.env.WEB_PORTAL_URL || 'http://localhost:3002';
      const mcpCallback = `http://localhost:${port}/mcp/auth/callback`;

      const loginUrl = new URL(`${webPortalUrl}/login`);
      loginUrl.searchParams.set('redirect', mcpCallback);
      loginUrl.searchParams.set('pending_id', pendingId);

      logger.info('MCP /authorize redirecting to web portal', { pendingId, loginUrl: loginUrl.toString() });
      res.redirect(loginUrl.toString());
    });

    // GET /mcp/auth/callback - Handle callback from web portal after login
    // Web portal should redirect here with access_token after successful login
    app.get('/mcp/auth/callback', async (req, res) => {
      const pendingId = req.query.pending_id as string;
      const accessToken = req.query.access_token as string;

      logger.info('MCP /mcp/auth/callback called', { pendingId, hasToken: !!accessToken });

      // Look up pending auth request
      const pending = pendingAuths.get(pendingId);
      if (!pending) {
        res.status(400).send('Invalid or expired authorization request. Please try again.');
        return;
      }

      // Check expiration
      if (Date.now() > pending.expiresAt) {
        pendingAuths.delete(pendingId);
        res.status(400).send('Authorization request expired. Please try again.');
        return;
      }

      if (!accessToken) {
        res.status(400).send('Missing access token. Please try logging in again.');
        return;
      }

      try {
        // Verify the Supabase token and get user
        const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
        const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);

        if (authError || !user) {
          logger.error('Supabase auth verification failed', { error: authError });
          res.status(401).send('Authentication failed. Please try again.');
          return;
        }

        // Look up PCP user by email
        const { data: pcpUser, error: userError } = await supabase
          .from('users')
          .select('id, email')
          .eq('email', user.email)
          .single();

        if (userError || !pcpUser) {
          logger.error('PCP user not found', { email: user.email, error: userError });
          res.status(403).send('User not found in PCP system. Please contact support.');
          return;
        }

        // Generate authorization code that stores the Supabase token
        const code = `pcp-code-${Date.now()}-${Math.random().toString(36).substring(7)}`;

        oauthCodes.set(code, {
          clientId: pending.clientId,
          codeChallenge: pending.codeChallenge,
          redirectUri: pending.redirectUri,
          supabaseToken: accessToken,
          userId: pcpUser.id,
          userEmail: pcpUser.email,
          expiresAt: Date.now() + 10 * 60 * 1000,
        });

        // Clean up pending auth
        pendingAuths.delete(pendingId);

        // Redirect back to Claude Code's callback
        const redirectUrl = new URL(pending.redirectUri);
        redirectUrl.searchParams.set('code', code);
        if (pending.state) {
          redirectUrl.searchParams.set('state', pending.state);
        }

        logger.info('MCP auth complete, redirecting to client', {
          userId: pcpUser.id,
          email: pcpUser.email,
        });

        res.redirect(redirectUrl.toString());
      } catch (error) {
        logger.error('Error completing MCP auth', { error });
        res.status(500).send('Authentication error. Please try again.');
      }
    });

    // POST /token - OAuth 2.0 Token Endpoint
    // Exchange authorization code for access token (with PKCE verification)
    app.post('/token', express.urlencoded({ extended: true }), (req, res) => {
      const { grant_type, code, code_verifier, client_id } = req.body;

      logger.info('MCP /token called', { grant_type, client_id, hasCode: !!code, hasVerifier: !!code_verifier });

      if (grant_type !== 'authorization_code') {
        res.status(400).json({ error: 'unsupported_grant_type' });
        return;
      }

      // Look up the authorization code
      const codeData = oauthCodes.get(code);
      if (!codeData) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code not found' });
        return;
      }

      // Check expiration
      if (Date.now() > codeData.expiresAt) {
        oauthCodes.delete(code);
        res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
        return;
      }

      // Verify PKCE code_verifier against stored code_challenge (S256)
      if (codeData.codeChallenge && code_verifier) {
        const computedChallenge = crypto
          .createHash('sha256')
          .update(code_verifier)
          .digest('base64url');

        if (computedChallenge !== codeData.codeChallenge) {
          logger.warn('PKCE verification failed', { expected: codeData.codeChallenge, computed: computedChallenge });
          res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
          return;
        }
      }

      // Delete used code
      oauthCodes.delete(code);

      // Return the Supabase JWT directly - it will be validated at /sse
      // Supabase tokens are typically valid for 1 hour, but can be refreshed
      const expiresIn = 3600; // 1 hour (Supabase default)

      logger.info('MCP /token returning Supabase JWT', {
        userId: codeData.userId,
        email: codeData.userEmail,
      });

      res.json({
        access_token: codeData.supabaseToken,  // Return the actual Supabase JWT
        token_type: 'Bearer',
        expires_in: expiresIn,
        scope: 'mcp:tools',
      });
    });

    // Admin API routes (for web dashboard)
    app.use(express.json());
    app.use('/api/admin', adminRouter);
    logger.info('Admin API routes registered at /api/admin');

    // Agent trigger routes (for agent-to-agent communication)
    app.use('/api/agent', agentTriggerRouter);
    logger.info('Agent trigger routes registered at /api/agent');

    // Refresh tools endpoint - notifies connected clients that tools have changed
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

    this.httpServer = app.listen(port, () => {
      logger.info(`MCP Server started with HTTP/SSE transport on port ${port}`);
      logger.info(`SSE endpoint: http://localhost:${port}/sse`);
      logger.info(`Message endpoint: http://localhost:${port}/message`);
    });

    // Initialize and start the channel gateway only if a message handler is configured
    // This allows running MCP Server standalone (for tools only) without starting listeners
    if (this.config.messageHandler) {
      await this.startChannelGateway();
    } else {
      logger.info('ChannelGateway not started (no messageHandler configured)');
    }
  }

  /**
   * Initialize and start the channel gateway
   * This is the central point for all messaging channels
   */
  private async startChannelGateway(): Promise<void> {
    logger.info('Initializing ChannelGateway...');

    this.channelGateway = createChannelGateway({
      ...this.config.channelGateway,
      dataComposer: this.dataComposer,
    });

    // Register message handler if provided
    if (this.config.messageHandler) {
      this.channelGateway.setMessageHandler(this.config.messageHandler);
    }

    // Register listeners with admin routes and MCP tools
    // This is done before start() so the listeners are available immediately after creation
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

    await this.channelGateway.start();

    // Register listeners immediately after start (even before connected events)
    const telegramListener = this.channelGateway.getTelegramListener();
    if (telegramListener) {
      setTelegramListener(telegramListener);
    }

    const whatsAppListener = this.channelGateway.getWhatsAppListener();
    if (whatsAppListener) {
      setWhatsAppListener(whatsAppListener);
    }

    logger.info('ChannelGateway started', this.channelGateway.getStatus());
  }

  /**
   * Get the underlying server instance
   */
  getServer(): McpServer {
    return this.server;
  }

  /**
   * Gracefully shutdown the server
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down MCP server...');

    // Stop channel gateway first (stops Telegram/WhatsApp listeners)
    if (this.channelGateway) {
      await this.channelGateway.stop();
      this.channelGateway = null;
    }

    // Close the MCP server (this closes the SSE transport)
    try {
      await this.server.close();
      this.sseTransport = null;
    } catch (error) {
      logger.warn('Error closing MCP server:', error);
    }

    if (this.httpServer) {
      // Force close all connections (Node 18.2+)
      this.httpServer.closeAllConnections();

      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    logger.info('MCP server shut down');
  }

  /**
   * Get the channel gateway instance
   */
  getChannelGateway(): ChannelGateway | null {
    return this.channelGateway;
  }

  /**
   * Get the HTTP port if running in HTTP mode
   */
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
   * Notify connected clients that tools have changed.
   * Clients should re-fetch the tools list.
   */
  async notifyToolsChanged(): Promise<void> {
    this.toolsVersion++;
    logger.info(`Tools changed, notifying clients (version ${this.toolsVersion})`);

    // The MCP protocol supports notifications/tools/list_changed
    // This tells clients to re-fetch the tools list
    try {
      // Access the underlying Protocol server to send notification
      const protocol = this.server.server;

      // Send the list_changed notification
      // Note: This will only work if a client is connected
      // The SDK uses 'notification' method with method name and params
      await protocol.notification({
        method: 'notifications/tools/list_changed',
        params: {},
      });

      logger.info('Tools list_changed notification sent');
    } catch (error) {
      // This might fail if no client is connected, which is fine
      logger.debug('Could not send tools notification (client may not be connected):', error);
    }
  }

  /**
   * Get current tools version
   */
  getToolsVersion(): number {
    return this.toolsVersion;
  }
}

export async function createMCPServer(dataComposer: DataComposer, config?: MCPServerConfig): Promise<MCPServer> {
  return new MCPServer(dataComposer, config);
}

export { ChannelGateway, type ChannelGatewayConfig, type IncomingMessageHandler };
