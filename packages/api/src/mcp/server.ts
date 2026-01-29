import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import cors from 'cors';
import type { Server } from 'http';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../config/constants';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { DataComposer } from '../data/composer';
import { registerAllTools, setMiniAppsRegistry } from './tools';
import { loadMiniApps, registerMiniAppTools, getMiniAppsInfo } from '../mini-apps';
import adminRouter, { setWhatsAppListener } from '../routes/admin';
import agentTriggerRouter, { getAgentGateway } from '../routes/agent-trigger';

export { setWhatsAppListener, getAgentGateway };

export class MCPServer {
  private server: McpServer;
  private dataComposer: DataComposer;
  private httpServer: Server | null = null;
  private sseTransport: SSEServerTransport | null = null;
  private miniAppsInfo: Array<{ name: string; version: string; description: string; triggers: string[]; functions: string[] }> = [];
  private toolsVersion = 0; // Incremented when tools change

  constructor(dataComposer: DataComposer) {
    this.dataComposer = dataComposer;

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

    // Enable CORS for Claude Code and other MCP clients
    app.use(cors());

    // SSE endpoint for MCP communication
    app.get('/sse', async (_req, res) => {
      logger.info('SSE connection request received');

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

    // Close the MCP server first (this closes the SSE transport)
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

export async function createMCPServer(dataComposer: DataComposer): Promise<MCPServer> {
  return new MCPServer(dataComposer);
}
