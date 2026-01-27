/**
 * PM2 Ecosystem Configuration
 *
 * This manages three separate processes:
 * 1. mcp     - MCP Server (tools, admin API) - restarts on code changes
 * 2. myra    - Messaging process (Telegram/WhatsApp) - persistent, manual restart only
 * 3. web     - Next.js admin dashboard - uses HMR
 *
 * Commands:
 *   pm2 start ecosystem.config.cjs    # Start all processes
 *   pm2 restart mcp                   # Restart MCP only
 *   pm2 restart myra                  # Restart Myra (reconnects messaging)
 *   pm2 logs                          # View all logs
 *   pm2 logs myra                     # View Myra logs only
 *   pm2 stop all                      # Stop everything
 *   pm2 delete all                    # Clean up
 */

const path = require('path');

const rootDir = __dirname;
const apiDir = path.join(rootDir, 'packages/api');
const webDir = path.join(rootDir, 'packages/web');

// Yarn workspaces hoists dependencies to root node_modules
const tsxBin = path.join(rootDir, 'node_modules/.bin/tsx');
const nextBin = path.join(rootDir, 'node_modules/.bin/next');

module.exports = {
  apps: [
    {
      name: 'mcp',
      cwd: apiDir,
      script: tsxBin,
      args: 'watch src/index.ts',
      watch: [path.join(apiDir, 'src')],
      ignore_watch: [
        'node_modules',
        '.auth',
        'src/myra',  // Don't restart MCP when Myra code changes
      ],
      env: {
        NODE_ENV: 'development',
        MCP_TRANSPORT: 'http',
      },
      max_restarts: 10,
      restart_delay: 1000,
    },
    {
      name: 'myra',
      cwd: apiDir,
      script: tsxBin,
      args: 'src/myra/index.ts',
      // NO watch - Myra is persistent, restart manually only
      watch: false,
      env: {
        NODE_ENV: 'development',
        ENABLE_WHATSAPP: 'true',
      },
      autorestart: true,
      max_restarts: 5,
      restart_delay: 5000,
    },
    {
      name: 'web',
      cwd: webDir,
      script: nextBin,
      args: 'dev -p 3002',
      watch: false,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
