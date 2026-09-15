import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { openBrowser, startCallbackServer } from './auth.js';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe('OAuth callback output', () => {
  it.each(['error_description', 'error'])('never reflects %s into HTML', async (field) => {
    const server = await startCallbackServer('synthetic-state');
    const outcome = server.result.catch((error: Error) => error);
    const payload = '<img src=x onerror="alert(1)">';
    const params = new URLSearchParams({ state: 'synthetic-state', error: 'access_denied' });
    params.set(field, payload);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/callback?${params}`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain('Authentication failed');
      expect(body).not.toContain(payload);
      expect(body).not.toContain('<img');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await outcome).toEqual(new Error(payload));
    } finally {
      server.close();
    }
  });

  it('validates state on provider-error callbacks too', async () => {
    const server = await startCallbackServer('synthetic-state');
    const outcome = server.result.catch((error: Error) => error);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/callback?error=access_denied`);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('State mismatch');
      expect(await outcome).toEqual(new Error('State mismatch'));
    } finally {
      server.close();
    }
  });

  it('still resolves a valid code without reflecting it', async () => {
    const server = await startCallbackServer('synthetic-state');
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/callback?state=synthetic-state&code=synthetic-code`
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('Authentication successful');
      expect(body).not.toContain('synthetic-code');
      expect(await server.result).toEqual({ code: 'synthetic-code', state: 'synthetic-state' });
    } finally {
      server.close();
    }
  });
});

it('opens the browser with a literal URL argument, never a shell command', () => {
  const url = 'https://auth.example.test/authorize?label=$(echo%20marker)&quote="';
  openBrowser(url);
  expect(execFile).toHaveBeenCalledExactlyOnceWith('open', [url]);
});
