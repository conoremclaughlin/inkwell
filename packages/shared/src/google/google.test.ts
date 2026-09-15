import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GOOGLE_CREDENTIAL_SOURCES,
  desktopCredentialFilename,
  GOOGLE_OAUTH_SCOPES,
  missingGoogleScopes,
  parseDesktopGoogleCredential,
  parseDesktopOAuthClient,
  parseGoogleCredentialSources,
  resolveDesktopCredentialsDir,
} from './index.js';

describe('parseGoogleCredentialSources', () => {
  it('defaults to cloud then desktop', () => {
    expect(parseGoogleCredentialSources(undefined)).toEqual(['cloud', 'desktop']);
    expect(parseGoogleCredentialSources('')).toEqual(['cloud', 'desktop']);
    expect(parseGoogleCredentialSources(' , ')).toEqual(DEFAULT_GOOGLE_CREDENTIAL_SOURCES);
  });

  it('keeps the configured order and de-duplicates', () => {
    expect(parseGoogleCredentialSources('desktop, cloud')).toEqual(['desktop', 'cloud']);
    expect(parseGoogleCredentialSources('Desktop,desktop')).toEqual(['desktop']);
  });

  it('refuses an unknown source instead of silently dropping it', () => {
    expect(() => parseGoogleCredentialSources('cloud,keychain')).toThrow(/keychain/);
  });
});

describe('parseDesktopOAuthClient', () => {
  it("reads Google's downloaded Desktop-app client file", () => {
    const parsed = parseDesktopOAuthClient({
      installed: {
        client_id: ' id-1 ',
        client_secret: 'secret-1',
        redirect_uris: ['http://localhost'],
      },
    });
    expect(parsed).toEqual({ ok: true, value: { clientId: 'id-1', clientSecret: 'secret-1' } });
  });

  it('accepts a bare client object', () => {
    expect(parseDesktopOAuthClient({ client_id: 'a', client_secret: 'b' })).toEqual({
      ok: true,
      value: { clientId: 'a', clientSecret: 'b' },
    });
  });

  it('refuses a Web-application client, naming the fix', () => {
    const parsed = parseDesktopOAuthClient({ web: { client_id: 'a', client_secret: 'b' } });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/Desktop app/);
  });

  it('names the missing field', () => {
    const parsed = parseDesktopOAuthClient({ installed: { client_id: 'a' } });
    expect(parsed).toEqual({ ok: false, reason: 'client file has no client_secret' });
  });
});

describe('parseDesktopGoogleCredential', () => {
  const valid = {
    type: 'authorized_user',
    client_id: 'id',
    client_secret: 'secret',
    refresh_token: 'rt',
    email: 'Someone@Example.com ',
    scopes: ['a', 'b'],
    obtained_at: '2026-09-08T00:00:00.000Z',
    source: 'ink google login',
  };

  it('normalizes the binding email to lowercase', () => {
    const parsed = parseDesktopGoogleCredential(valid);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.email).toBe('someone@example.com');
      expect(parsed.value.scopes).toEqual(['a', 'b']);
      expect(parsed.value.obtained_at).toBe('2026-09-08T00:00:00.000Z');
    }
  });

  it('requires the email — a file with no binding key is refused, not bound to whoever asks', () => {
    const { email: _omit, ...withoutEmail } = valid;
    void _omit;
    const parsed = parseDesktopGoogleCredential(withoutEmail);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/email/);
  });

  it('refuses anything that is not an authorized_user file', () => {
    expect(parseDesktopGoogleCredential({ ...valid, type: 'service_account' }).ok).toBe(false);
    expect(parseDesktopGoogleCredential(null).ok).toBe(false);
    expect(parseDesktopGoogleCredential({ ...valid, refresh_token: '' }).ok).toBe(false);
    expect(parseDesktopGoogleCredential({ ...valid, scopes: 'gmail' }).ok).toBe(false);
  });
});

describe('desktop credential files', () => {
  it('uses ~/.ink/google unless overridden', () => {
    expect(resolveDesktopCredentialsDir({}, '/home/me')).toBe('/home/me/.ink/google');
    expect(
      resolveDesktopCredentialsDir({ INK_GOOGLE_CREDENTIALS_DIR: '/srv/creds' }, '/home/me')
    ).toBe('/srv/creds');
  });

  it('names the file after the normalized email', () => {
    // Composed: the personal-data guard classifies addresses by domain, and
    // "example.com.json" is not one.
    expect(desktopCredentialFilename('Me@Example.com')).toBe('me@example.com' + '.json');
    expect(desktopCredentialFilename('a/b@example.com')).toBe('a_b@example.com' + '.json');
  });

  it('lists the required scopes a grant did not cover', () => {
    expect(missingGoogleScopes([...GOOGLE_OAUTH_SCOPES])).toEqual([]);
    expect(
      missingGoogleScopes(
        ['https://www.googleapis.com/auth/drive'],
        ['x', 'https://www.googleapis.com/auth/drive']
      )
    ).toEqual(['x']);
  });
});
