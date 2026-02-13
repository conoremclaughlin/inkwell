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
 * - Heartbeat service for scheduled reminders
 * - Agent gateway for inter-agent triggers
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
const basePort = Number(process.env.PCP_PORT_BASE || 3001); // MCP-first base
const apiPort = Number(process.env.PORT || basePort - 1);
const mcpPort = Number(process.env.MCP_HTTP_PORT || basePort);
const webPort = Number(process.env.WEB_PORT || basePort + 1);
const myraPort = Number(process.env.MYRA_HTTP_PORT || basePort + 2);

// Yarn workspaces hoists dependencies to root node_modules
const tsxBin = path.join(rootDir, 'node_modules/.bin/tsx');
const nextBin = path.join(rootDir, 'node_modules/.bin/next');

module.exports = {
  apps: [
    {
      // Full PCP Server: MCP + ChannelGateway + SessionService
      // Using SessionService for stateless, horizontally-scalable architecture
      name: 'pcp',
      cwd: apiDir,
      script: tsxBin,
      args: 'src/server.ts',
      watch: false,  // Disable watch - restart manually with: pm2 restart pcp
      env: {
        NODE_ENV: 'development',
        MCP_TRANSPORT: 'http',
        PORT: String(apiPort),
        MCP_HTTP_PORT: String(mcpPort),
        MYRA_HTTP_PORT: String(myraPort),
        ENABLE_WHATSAPP: 'true',
        ENABLE_DISCORD: 'false',
        AGENT_ID: 'myra',  // Identity for the Claude Code backend
        CLAUDECODE: '',     // Prevent nested-session detection when spawning Claude Code
      },
      max_restarts: 10,
      restart_delay: 1000,
    },
    {
      name: 'web',
      cwd: webDir,
      script: nextBin,
      args: `dev -p ${webPort}`,
      watch: false,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
