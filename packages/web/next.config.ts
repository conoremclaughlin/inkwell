import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Allow API calls to the backend
  async rewrites() {
    return [
      // WhatsApp endpoints go to Myra (persistent messaging process)
      {
        source: '/api/admin/whatsapp/:path*',
        destination: `${process.env.MYRA_URL || 'http://localhost:3003'}/api/admin/whatsapp/:path*`,
      },
      // Other admin endpoints go to MCP server
      {
        source: '/api/admin/:path*',
        destination: `${process.env.API_URL || 'http://localhost:3001'}/api/admin/:path*`,
      },
      // Chat endpoints go to MCP server
      {
        source: '/api/chat/:path*',
        destination: `${process.env.API_URL || 'http://localhost:3001'}/api/chat/:path*`,
      },
      // Kindle endpoints go to MCP server
      {
        source: '/api/kindle/:path*',
        destination: `${process.env.API_URL || 'http://localhost:3001'}/api/kindle/:path*`,
      },
    ];
  },
};

export default nextConfig;
