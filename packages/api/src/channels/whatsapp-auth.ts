/**
 * WhatsApp Auth Management
 *
 * Handles Baileys authentication state storage and QR code login.
 * Credentials stored in ~/.pcp/credentials/whatsapp/<accountId>/
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger';

// Baileys auth state type (inferred from dynamic import)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AuthenticationState = any;

const PCP_DIR = path.join(os.homedir(), '.pcp');
const CREDENTIALS_DIR = path.join(PCP_DIR, 'credentials', 'whatsapp');

export interface WhatsAppAuthConfig {
  /** Account identifier (default: 'default') */
  accountId?: string;
  /** Custom auth directory (overrides default) */
  authDir?: string;
}

/**
 * Resolve the auth directory for a WhatsApp account
 */
export function resolveAuthDir(accountId = 'default'): string {
  return path.join(CREDENTIALS_DIR, accountId);
}

/**
 * Ensure the auth directory exists
 */
export async function ensureAuthDir(authDir: string): Promise<void> {
  await fs.mkdir(authDir, { recursive: true });
}

/**
 * Check if WhatsApp credentials exist for an account
 */
export async function authExists(accountId = 'default'): Promise<boolean> {
  const authDir = resolveAuthDir(accountId);
  const credsPath = path.join(authDir, 'creds.json');

  try {
    const stats = await fs.stat(credsPath);
    return stats.isFile() && stats.size > 1;
  } catch {
    return false;
  }
}

/**
 * Get the age of the auth credentials in milliseconds
 */
export async function getAuthAgeMs(accountId = 'default'): Promise<number | null> {
  const authDir = resolveAuthDir(accountId);
  const credsPath = path.join(authDir, 'creds.json');

  try {
    const stats = await fs.stat(credsPath);
    return Date.now() - stats.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Read the self ID (phone number) from saved credentials
 */
export function readSelfId(accountId = 'default'): { e164: string | null; jid: string | null } {
  const authDir = resolveAuthDir(accountId);
  const credsPath = path.join(authDir, 'creds.json');

  try {
    if (!fsSync.existsSync(credsPath)) {
      return { e164: null, jid: null };
    }

    const raw = fsSync.readFileSync(credsPath, 'utf-8');
    const creds = JSON.parse(raw);
    const jid = creds.me?.id || null;

    // Extract E.164 from JID (format: 1234567890:123@s.whatsapp.net)
    let e164: string | null = null;
    if (jid) {
      const match = jid.match(/^(\d+)/);
      if (match) {
        e164 = `+${match[1]}`;
      }
    }

    return { e164, jid };
  } catch (error) {
    logger.warn('Failed to read WhatsApp self ID', { error });
    return { e164: null, jid: null };
  }
}

/**
 * Load auth state for Baileys
 */
export async function loadAuthState(accountId = 'default'): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  authDir: string;
}> {
  const authDir = resolveAuthDir(accountId);
  await ensureAuthDir(authDir);

  // Restore from backup if main creds are corrupted
  await maybeRestoreFromBackup(authDir);

  // Dynamic import for ESM module
  const { useMultiFileAuthState } = await import('@whiskeysockets/baileys');
  const { state, saveCreds: baseSaveCreds } = await useMultiFileAuthState(authDir);

  // Wrap saveCreds to also maintain a backup
  const saveCreds = async () => {
    await baseSaveCreds();
    await createBackup(authDir);
  };

  return { state, saveCreds, authDir };
}

/**
 * Create a backup of creds.json
 */
async function createBackup(authDir: string): Promise<void> {
  const credsPath = path.join(authDir, 'creds.json');
  const backupPath = path.join(authDir, 'creds.json.bak');

  try {
    const exists = await fs
      .stat(credsPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) return;

    const raw = await fs.readFile(credsPath, 'utf-8');
    // Only backup if valid JSON
    JSON.parse(raw);
    await fs.copyFile(credsPath, backupPath);
  } catch {
    // Ignore backup failures
  }
}

/**
 * Restore creds from backup if main file is corrupted
 */
async function maybeRestoreFromBackup(authDir: string): Promise<void> {
  const credsPath = path.join(authDir, 'creds.json');
  const backupPath = path.join(authDir, 'creds.json.bak');

  try {
    // Check if main creds exist and are valid
    const mainExists = await fs
      .stat(credsPath)
      .then(() => true)
      .catch(() => false);
    if (mainExists) {
      const raw = await fs.readFile(credsPath, 'utf-8');
      JSON.parse(raw); // Throws if invalid
      return; // Main creds are fine
    }

    // Try to restore from backup
    const backupExists = await fs
      .stat(backupPath)
      .then(() => true)
      .catch(() => false);
    if (backupExists) {
      const backupRaw = await fs.readFile(backupPath, 'utf-8');
      JSON.parse(backupRaw); // Validate backup
      await fs.copyFile(backupPath, credsPath);
      logger.info('Restored WhatsApp credentials from backup');
    }
  } catch (error) {
    logger.warn('Failed to restore WhatsApp credentials from backup', { error });
  }
}

/**
 * Delete auth credentials for an account (logout)
 */
export async function deleteAuth(accountId = 'default'): Promise<boolean> {
  const authDir = resolveAuthDir(accountId);

  try {
    await fs.rm(authDir, { recursive: true, force: true });
    logger.info('Deleted WhatsApp credentials', { accountId });
    return true;
  } catch (error) {
    logger.error('Failed to delete WhatsApp credentials', { accountId, error });
    return false;
  }
}

/**
 * List all WhatsApp accounts with credentials
 */
export async function listAccounts(): Promise<string[]> {
  try {
    const entries = await fs.readdir(CREDENTIALS_DIR, { withFileTypes: true });
    const accounts: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const credsPath = path.join(CREDENTIALS_DIR, entry.name, 'creds.json');
        const exists = await fs
          .stat(credsPath)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          accounts.push(entry.name);
        }
      }
    }

    return accounts;
  } catch {
    return [];
  }
}
