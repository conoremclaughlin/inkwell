/**
 * Authenticator codes for saved logins (TOTP, RFC 6238).
 *
 * A saved login may keep an authenticator's setup key among its secrets. The
 * server never sends the key back; it answers only with the current code
 * (routes/admin-vault.ts).
 */
import { createHmac } from 'node:crypto';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface Authenticator {
  /** The shared secret, base32 without padding or spaces. */
  secret: string;
  algorithm: TotpAlgorithm;
  digits: 6 | 8;
  period: number;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Longer than any setup key or otpauth address, and refused before it is read. */
const MAX_INPUT = 2048;

/**
 * The text without its trailing `=` padding. A loop, not /=+$/: that regex
 * backtracks from every `=` in a run that doesn't end the text, which is
 * quadratic, and the text is whatever a person sent.
 */
function withoutPadding(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '=') end -= 1;
  return text.slice(0, end);
}

/**
 * Bytes of a base32 secret, ignoring case, spaces, dashes and padding; null if
 * it isn't well-formed base32 (RFC 4648 §6): a final group of 2, 4, 5 or 7
 * characters, or none, whose spare bits are zero. A stray character is never
 * dropped to make it fit.
 */
export function base32Bytes(input: string): Buffer | null {
  const clean = withoutPadding(input.toUpperCase().replace(/[\s-]/g, ''));
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  if (![0, 2, 4, 5, 7].includes(clean.length % 8)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
  return Buffer.from(out);
}

/**
 * An authenticator from what a person typed: the setup key a site shows, or
 * the `otpauth://totp/...` address its QR code holds. Null if it isn't one:
 * a secret under 80 bits, or settings outside what authenticator apps use.
 */
export function authenticatorFrom(input: string): Authenticator | null {
  if (input.length > MAX_INPUT) return null;
  const text = input.trim();
  let secret = text;
  let algorithm: TotpAlgorithm = 'SHA1';
  let digits: 6 | 8 = 6;
  let period = 30;
  if (/^otpauth:/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.host.toLowerCase() !== 'totp') return null;
    secret = url.searchParams.get('secret') ?? '';
    const alg = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
    if (alg !== 'SHA1' && alg !== 'SHA256' && alg !== 'SHA512') return null;
    algorithm = alg;
    const d = url.searchParams.get('digits') ?? '6';
    if (d !== '6' && d !== '8') return null;
    digits = d === '8' ? 8 : 6;
    const p = Number(url.searchParams.get('period') ?? '30');
    if (!Number.isInteger(p) || p < 15 || p > 300) return null;
    period = p;
  }
  const bytes = base32Bytes(secret);
  if (!bytes || bytes.length < 10) return null;
  return {
    secret: withoutPadding(secret.toUpperCase().replace(/[\s-]/g, '')),
    algorithm,
    digits,
    period,
  };
}

/** The code an authenticator shows at `nowMs`, and how many seconds it has left. */
export function authenticatorCode(
  auth: Authenticator,
  nowMs: number = Date.now()
): { code: string; secondsRemaining: number; period: number } {
  const seconds = Math.floor(nowMs / 1000);
  const counter = Math.floor(seconds / auth.period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(auth.algorithm.toLowerCase(), base32Bytes(auth.secret)!)
    .update(message)
    .digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  const code = String(binary % 10 ** auth.digits).padStart(auth.digits, '0');
  return { code, secondsRemaining: auth.period - (seconds % auth.period), period: auth.period };
}
