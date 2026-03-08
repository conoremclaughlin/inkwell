/**
 * PM2 Ecosystem Configuration
 *
 * Two modes:
 *
 * 1. `yarn pm2:dev` — Wraps `yarn dev` in PM2 for centralized logging.
 *    Same hot-reload behavior, but logs go to `pm2 logs` instead of a terminal.
 *    Uses the single "pcp-dev" process that runs both API + web via concurrently.
 *
 * 2. `yarn pm2:start` — Legacy per-process mode (separate pcp + web processes).
 *    No hot reload. Useful for production-like setups.
 *
 * Commands:
 *   pm2 start ecosystem.config.cjs --only pcp-dev   # Mode 1
 *   pm2 start ecosystem.config.cjs --only pcp,web   # Mode 2
 *   pm2 logs                                         # View all logs
 *   pm2 logs pcp-dev                                 # View dev logs only
 *   pm2 delete all && pm2 start ...                  # Full reset (avoids env caching)
 */

const path = require('path');

const rootDir = __dirname;
const apiDir = path.join(rootDir, 'packages/api');
const webDir = path.join(rootDir, 'packages/web');
const basePort = Number(process.env.PCP_PORT_BASE || 3001);
const apiPort = Number(process.env.PORT || basePort - 1);
const mcpPort = Number(process.env.MCP_HTTP_PORT || basePort);
const webPort = Number(process.env.WEB_PORT || basePort + 1);
const myraPort = Number(process.env.MYRA_HTTP_PORT || basePort + 2);

// Yarn workspaces hoists dependencies to root node_modules
const tsxBin = path.join(rootDir, 'node_modules/.bin/tsx');
const nextBin = path.join(rootDir, 'node_modules/.bin/next');

module.exports = {
  apps: [
    // ─── Mode 1: Wrap `yarn dev` for centralized logging ───
    {
      name: 'pcp-dev',
      cwd: rootDir,
      script: 'yarn',
      args: 'dev',
      watch: false, // yarn dev handles its own file watching
      env: {
        NODE_ENV: 'development',
        CLAUDECODE: '', // Prevent nested-session detection when spawning Claude Code
      },
      max_restarts: 5,
      restart_delay: 2000,
    },

    // ─── Mode 2: Legacy per-process mode ───
    {
      name: 'pcp',
      cwd: apiDir,
      script: tsxBin,
      args: 'src/server.ts',
      watch: false,
      env: {
        NODE_ENV: 'development',
        MCP_TRANSPORT: 'http',
        PORT: String(apiPort),
        MCP_HTTP_PORT: String(mcpPort),
        MYRA_HTTP_PORT: String(myraPort),
        ENABLE_WHATSAPP: 'true',
        ENABLE_DISCORD: 'false',
        AGENT_ID: 'myra',
        CLAUDECODE: '',
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
