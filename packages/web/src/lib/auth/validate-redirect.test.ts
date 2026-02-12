import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isAllowedMcpRedirect } from './validate-redirect';

describe('isAllowedMcpRedirect', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('localhost (dev)', () => {
    it('allows localhost on any port', () => {
      expect(isAllowedMcpRedirect('http://localhost:3001/mcp/auth/callback')).toBe(true);
    });

    it('allows localhost without port', () => {
      expect(isAllowedMcpRedirect('http://localhost/callback')).toBe(true);
    });

    it('allows 127.0.0.1', () => {
      expect(isAllowedMcpRedirect('http://127.0.0.1:3001/mcp/auth/callback')).toBe(true);
    });
  });

  describe('API_URL matching', () => {
    it('allows redirect matching API_URL origin', () => {
      process.env.API_URL = 'https://api.example.com';
      expect(isAllowedMcpRedirect('https://api.example.com/mcp/auth/callback')).toBe(true);
    });

    it('allows redirect matching API_URL origin with port', () => {
      process.env.API_URL = 'https://api.example.com:8443';
      expect(isAllowedMcpRedirect('https://api.example.com:8443/mcp/auth/callback')).toBe(true);
    });

    it('rejects different origin from API_URL', () => {
      process.env.API_URL = 'https://api.example.com';
      expect(isAllowedMcpRedirect('https://evil.com/steal')).toBe(false);
    });

    it('rejects subdomain of API_URL', () => {
      process.env.API_URL = 'https://api.example.com';
      expect(isAllowedMcpRedirect('https://evil.api.example.com/steal')).toBe(false);
    });
  });

  describe('protocol enforcement', () => {
    it('rejects non-HTTPS for non-localhost', () => {
      process.env.API_URL = 'https://api.example.com';
      expect(isAllowedMcpRedirect('http://api.example.com/mcp/auth/callback')).toBe(false);
    });

    it('allows HTTP for localhost', () => {
      expect(isAllowedMcpRedirect('http://localhost:3001/callback')).toBe(true);
    });
  });

  describe('invalid input', () => {
    it('rejects empty string', () => {
      expect(isAllowedMcpRedirect('')).toBe(false);
    });

    it('rejects non-URL string', () => {
      expect(isAllowedMcpRedirect('not-a-url')).toBe(false);
    });

    it('rejects javascript: URLs', () => {
      expect(isAllowedMcpRedirect('javascript:alert(1)')).toBe(false);
    });

    it('rejects data: URLs', () => {
      expect(isAllowedMcpRedirect('data:text/html,<script>alert(1)</script>')).toBe(false);
    });
  });

  describe('attacker scenarios', () => {
    it('rejects attacker-controlled domain', () => {
      process.env.API_URL = 'https://api.example.com';
      expect(isAllowedMcpRedirect('https://attacker.com/steal-tokens')).toBe(false);
    });

    it('rejects attacker domain without API_URL set', () => {
      delete process.env.API_URL;
      expect(isAllowedMcpRedirect('https://attacker.com/steal-tokens')).toBe(false);
    });
  });
});
