/**
 * PM2 Ecosystem Configuration
 *
 * This manages the PCP server processes:
 * 1. pcp     - Full PCP Server (MCP + ChannelGateway + SessionHost)
 * 2. web     - Next.js admin dashboard
 *
 * The 'pcp' process runs server.ts which integrates:
 * - MCP Server (tools, admin API)
 * - ChannelGateway (Telegram/WhatsApp listeners)
 * - SessionHost (Claude Code backend)
 *
 * Legacy 'myra' process is kept but disabled. Enable with:
 *   ENABLE_MYRA_LISTENERS=true pm2 start myra
 *
 * Commands:
 *   pm2 start ecosystem.config.cjs    # Start all processes
 *   pm2 restart pcp                   # Restart PCP server
 *   pm2 logs                          # View all logs
 *   pm2 logs pcp                      # View PCP logs only
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
      // Full PCP Server: MCP + ChannelGateway + SessionHost
      name: 'pcp',
      cwd: apiDir,
      script: tsxBin,
      args: 'watch src/server.ts',
      watch: [path.join(apiDir, 'src')],
      ignore_watch: [
        'node_modules',
        '.auth',
        'src/myra',  // Legacy Myra process
      ],
      env: {
        NODE_ENV: 'development',
        MCP_TRANSPORT: 'http',
        ENABLE_WHATSAPP: 'true',
      },
      max_restarts: 10,
      restart_delay: 1000,
    },
    {
      // Legacy standalone Myra process (disabled by default)
      // Enable with: ENABLE_MYRA_LISTENERS=true pm2 start myra
      name: 'myra',
      cwd: apiDir,
      script: tsxBin,
      args: 'src/myra/index.ts',
      watch: false,
      env: {
        NODE_ENV: 'development',
        ENABLE_WHATSAPP: 'true',
        // Listeners disabled - use 'pcp' process instead
        // Set ENABLE_MYRA_LISTENERS=true to enable legacy mode
      },
      autorestart: false,  // Disabled by default
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
