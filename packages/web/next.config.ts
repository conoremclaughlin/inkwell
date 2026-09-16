import type { NextConfig } from 'next';

const pcpPortBase = Number(process.env.INK_PORT_BASE || 3001);
const apiUrl = process.env.API_URL || `http://localhost:${pcpPortBase}`;

const nextConfig: NextConfig = {
  // CSRF compares the browser's exact origin against request.url. NextURL
  // otherwise rewrites loopback IPs to localhost, losing the original host.
  // Preserve it rather than granting cross-origin equivalence to local aliases.
  skipMiddlewareUrlNormalize: true,
  // Allow API calls to the backend
  async rewrites() {
    return [
      // Other admin endpoints go to MCP server
      {
        source: '/api/admin/:path*',
        destination: `${apiUrl}/api/admin/:path*`,
      },
      // Chat endpoints go to MCP server
      {
        source: '/api/chat/:path*',
        destination: `${apiUrl}/api/chat/:path*`,
      },
      // Kindle endpoints go to MCP server
      {
        source: '/api/kindle/:path*',
        destination: `${apiUrl}/api/kindle/:path*`,
      },
      // System health/version info (used for restart-required banners)
      {
        source: '/api/system/health',
        destination: `${apiUrl}/health`,
      },
    ];
  },
};

export default nextConfig;
