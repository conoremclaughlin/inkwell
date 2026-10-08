/**
 * Encryption for the sealed saved-login store (sealed-store.ts).
 *
 * Each half is AES-256-GCM under the server's sealing key, with what the half
 * is bound to (store.ts bindingFor: its owner, its login, which half) as
 * associated data, so a sealed value moved to another row, another person or
 * the other half no longer opens.
 *
 * The key is SAVED_LOGINS_SEALING_KEY: 32 bytes, base64. Without a valid key
 * the sealed store is unavailable rather than unencrypted. Losing the key
 * loses every saved password, so it must be kept and backed up like any
 * other secret.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The sealing key from the environment, or null if it is missing or malformed. */
export function sealingKeyFrom(source: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = source.SAVED_LOGINS_SEALING_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  // Only canonical base64 of exactly 32 bytes: Buffer would skip stray characters.
  return key.length === 32 && key.toString('base64') === raw ? key : null;
}

/** Encrypts `plaintext`; the result is `v1.` and base64 of nonce, tag and ciphertext. */
export function seal(key: Buffer, plaintext: string, boundTo: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(boundTo, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

/** Decrypts what `seal` made for the same binding; throws if anything differs. */
export function open(key: Buffer, sealed: string, boundTo: string): string {
  if (!sealed.startsWith(`${VERSION}.`)) throw new Error('Unknown sealed format');
  const bytes = Buffer.from(sealed.slice(VERSION.length + 1), 'base64');
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error('Truncated sealed value');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(boundTo, 'utf8'));
  decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}
