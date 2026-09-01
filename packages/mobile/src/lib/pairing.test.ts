import { describe, expect, it } from 'vitest';
import {
  formatPairingCode,
  normalizePairingCode,
  parsePairingInput,
  pickReachableUrl,
} from './pairing';

describe('parsePairingInput', () => {
  it('reads the dashboard QR payload and cleans the URL list', () => {
    const payload = JSON.stringify({
      ink: 1,
      c: 'ABCDEFGHJKLM',
      u: [
        'https://ink.example.com/',
        'http://192.168.1.20:3001',
        'http://192.168.1.20:3001', // duplicate
        'ftp://nope', // wrong scheme
        42, // not a string
      ],
    });

    expect(parsePairingInput(payload)).toEqual({
      code: 'ABCDEFGHJKLM',
      urls: ['https://ink.example.com', 'http://192.168.1.20:3001'],
    });
  });

  it('puts https candidates before http ones, keeping order within each group', () => {
    const payload = JSON.stringify({
      ink: 1,
      c: 'ABCDEFGHJKLM',
      u: ['http://10.0.0.2:3001', 'https://a.example', 'http://10.0.0.3:3001', 'https://b.example'],
    });
    expect(parsePairingInput(payload)?.urls).toEqual([
      'https://a.example',
      'https://b.example',
      'http://10.0.0.2:3001',
      'http://10.0.0.3:3001',
    ]);
  });

  it('accepts a hand-typed code in any casing or grouping, with no URLs', () => {
    expect(parsePairingInput(' abcd-efgh jklm ')).toEqual({ code: 'ABCDEFGHJKLM', urls: [] });
  });

  it('rejects QR codes for other things and incomplete codes', () => {
    expect(parsePairingInput('https://example.com/menu')).toBeNull();
    expect(parsePairingInput('{"foo":"bar"}')).toBeNull();
    expect(parsePairingInput('{not json')).toBeNull();
    expect(parsePairingInput('ABCD-EFGH')).toBeNull();
    expect(parsePairingInput('')).toBeNull();
  });

  it('rejects a payload whose code is the wrong length even when well-formed', () => {
    expect(parsePairingInput(JSON.stringify({ ink: 1, c: 'ABC', u: [] }))).toBeNull();
  });
});

describe('code formatting', () => {
  it('round-trips through the dashed display form', () => {
    const shown = formatPairingCode('ABCDEFGHJKLM');
    expect(shown).toBe('ABCD-EFGH-JKLM');
    expect(normalizePairingCode(shown)).toBe('ABCDEFGHJKLM');
  });
});

describe('pickReachableUrl', () => {
  it('prefers list order among the candidates that answer', async () => {
    const up = new Set(['http://b', 'http://c']);
    const picked = await pickReachableUrl(['http://a', 'http://b', 'http://c'], async (u) =>
      up.has(u)
    );
    expect(picked).toBe('http://b');
  });

  it('treats a throwing probe as unreachable', async () => {
    const picked = await pickReachableUrl(['http://a', 'http://b'], async (u) => {
      if (u === 'http://a') throw new Error('timeout');
      return true;
    });
    expect(picked).toBe('http://b');
  });

  it('returns null when nothing answers', async () => {
    expect(await pickReachableUrl(['http://a'], async () => false)).toBeNull();
    expect(await pickReachableUrl([], async () => true)).toBeNull();
  });
});
