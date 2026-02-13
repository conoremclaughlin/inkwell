import type { NextConfig } from 'next';

const pcpPortBase = Number(process.env.PCP_PORT_BASE || 3001);
const apiUrl = process.env.API_URL || `http://localhost:${pcpPortBase}`;

const nextConfig: NextConfig = {
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
    ];
  },
};

export default nextConfig;
