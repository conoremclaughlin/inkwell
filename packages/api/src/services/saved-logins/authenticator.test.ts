import { describe, expect, it } from 'vitest';
import { authenticatorCode, authenticatorFrom, base32Bytes } from './authenticator';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 of some bytes, for writing test secrets. */
function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

describe('authenticators', () => {
  // RFC 6238, appendix B: the secrets are these ASCII strings.
  const sha1 = base32(Buffer.from('12345678901234567890'));
  const sha256 = base32(Buffer.from('12345678901234567890123456789012'));
  const sha512 = base32(
    Buffer.from('1234567890123456789012345678901234567890123456789012345678901234')
  );

  it('makes the RFC 6238 codes', () => {
    const vectors: Array<[number, string, string, string]> = [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [2000000000, '69279037', '90698825', '38618901'],
    ];
    for (const [time, a, b, c] of vectors) {
      const at = time * 1000;
      expect(
        authenticatorCode({ secret: sha1, algorithm: 'SHA1', digits: 8, period: 30 }, at).code
      ).toBe(a);
      expect(
        authenticatorCode({ secret: sha256, algorithm: 'SHA256', digits: 8, period: 30 }, at).code
      ).toBe(b);
      expect(
        authenticatorCode({ secret: sha512, algorithm: 'SHA512', digits: 8, period: 30 }, at).code
      ).toBe(c);
    }
    // Six digits are the last six of the eight.
    expect(authenticatorCode(authenticatorFrom(sha1)!, 59_000)).toEqual({
      code: '287082',
      secondsRemaining: 1,
      period: 30,
    });
  });

  it('takes a setup key however it is typed', () => {
    const spaced = sha1.toLowerCase().replace(/(.{4})/g, '$1 ');
    expect(authenticatorFrom(spaced)).toEqual({
      secret: sha1,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
    expect(base32Bytes(`${sha1}====`)).toEqual(Buffer.from('12345678901234567890'));
  });

  it('takes the otpauth address a QR code holds', () => {
    expect(
      authenticatorFrom(
        `otpauth://totp/Example:ada@example.test?secret=${sha256}&issuer=Example&algorithm=SHA256&digits=8&period=60`
      )
    ).toEqual({ secret: sha256, algorithm: 'SHA256', digits: 8, period: 60 });
  });

  it('reads only well-formed base32 (RFC 4648 §6)', () => {
    // A final group has 2, 4, 5 or 7 characters, or none.
    for (const length of [1, 3, 6, 9, 17]) expect(base32Bytes('A'.repeat(length))).toBeNull();
    for (const length of [2, 4, 5, 7, 8, 16])
      expect(base32Bytes('A'.repeat(length))).not.toBeNull();
    // Its spare bits are zero: "AB" leaves two bits, and B sets one.
    expect(base32Bytes('AA')).toEqual(Buffer.from([0]));
    expect(base32Bytes('AB')).toBeNull();
    expect(authenticatorFrom('A'.repeat(17))).toBeNull();
    expect(authenticatorFrom(`otpauth://totp/x?secret=${'A'.repeat(17)}`)).toBeNull();
  });

  it('reads a long run of padding in linear time', () => {
    // /=+$/ backtracks on every position of a run of `=` that doesn't end the
    // text: 40,000 of them took 2.4 s, so this took about a minute.
    expect(base32Bytes(`${sha1}${'='.repeat(200_000)}x`)).toBeNull();
    expect(base32Bytes(`${sha1}${'='.repeat(200_000)}`)).toEqual(
      Buffer.from('12345678901234567890')
    );
  });

  it('refuses anything longer than an otpauth address could need, before reading it', () => {
    expect(authenticatorFrom(`${sha1}${' '.repeat(4096)}`)).toBeNull();
    expect(authenticatorFrom(`${sha1}${' '.repeat(100)}`)).not.toBeNull();
  });

  it('refuses what isn’t an authenticator', () => {
    for (const input of [
      '',
      'not base32!',
      'ABCDEFGH', // 40 bits: too short
      `otpauth://hotp/x?secret=${sha1}`,
      `otpauth://totp/x?secret=${sha1}&algorithm=MD5`,
      `otpauth://totp/x?secret=${sha1}&digits=7`,
      `otpauth://totp/x?secret=${sha1}&period=5`,
      'otpauth://totp/x',
      'otpauth://%%',
    ]) {
      expect(authenticatorFrom(input)).toBeNull();
    }
  });
});
