// Import the config directly: Next's loadConfig reads real dotenv files in
// the checkout. This contract test needs no server or environment credentials.
import { describe, expect, it } from 'vitest';
import config from '../next.config';

describe('browser companion reverse proxy', () => {
  it('forwards only the companion namespace alongside the existing admin target', async () => {
    const rewrites = await config.rewrites!();
    if (!Array.isArray(rewrites)) throw new Error('Unexpected rewrite shape');
    const admin = rewrites.find((route) => route.source === '/api/admin/:path*');
    expect(admin).toBeTruthy();
    expect(rewrites.find((route) => route.source === '/api/browser-companion/:path*')).toEqual({
      source: '/api/browser-companion/:path*',
      destination: admin!.destination.replace('/api/admin/', '/api/browser-companion/'),
    });
    expect(rewrites.some((route) => route.source === '/api/:path*')).toBe(false);
  });
});
