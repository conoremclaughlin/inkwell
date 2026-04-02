import { getDataComposer } from './data/composer';
import { createMCPServer } from './mcp/server';
import { logger } from './utils/logger';
import { env } from './config/env';

async function main() {
  try {
    logger.info('Starting Inkstand server...');
    logger.info(`Environment: ${env.NODE_ENV}`);
    logger.info(`MCP Transport: ${env.MCP_TRANSPORT}`);

    // Initialize data layer
    logger.info('Initializing data layer...');
    const dataComposer = await getDataComposer();

    // Test database connection
    const isHealthy = await dataComposer.healthCheck();
    if (!isHealthy) {
      throw new Error('Database health check failed');
    }
    logger.info('Database connection healthy');

    // Create and start MCP server
    logger.info('Creating MCP server...');
    const mcpServer = await createMCPServer(dataComposer);

    logger.info('Starting MCP server...');
    await mcpServer.start();

    logger.info('Inkstand server is running!');

    // Graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await mcpServer.shutdown();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await mcpServer.shutdown();
      process.exit(0);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
main();
