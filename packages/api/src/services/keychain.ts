/**
 * macOS Keychain Credential Storage
 *
 * Stores and retrieves credentials using the macOS Keychain via the
 * `security` CLI. All items use the service prefix "ink:" for namespacing.
 *
 * Credentials are stored as generic passwords with:
 * - service: "ink:<name>" (the credential name, e.g., "ink:gfiber")
 * - account: the label/description
 * - password: the actual secret value
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const SERVICE_PREFIX = 'ink:';

export interface KeychainCredential {
  name: string;
  label: string;
  createdAt: string | null;
  modifiedAt: string | null;
}

export interface KeychainCredentialWithValue extends KeychainCredential {
  value: string;
}

function serviceName(name: string): string {
  return `${SERVICE_PREFIX}${name}`;
}

/**
 * Save a credential to the Keychain. Updates if it already exists.
 */
export async function saveCredential(name: string, value: string, label?: string): Promise<void> {
  const svc = serviceName(name);
  const acct = label || name;
  await execFileAsync('security', [
    'add-generic-password',
    '-s',
    svc,
    '-a',
    acct,
    '-w',
    value,
    '-U',
  ]);
}

/**
 * Retrieve a credential value from the Keychain.
 * Returns null if not found.
 */
export async function getCredentialValue(name: string): Promise<string | null> {
  const svc = serviceName(name);
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', svc, '-w']);
    return stdout.trimEnd();
  } catch {
    return null;
  }
}

/**
 * Delete a credential from the Keychain.
 * Returns true if deleted, false if not found.
 */
export async function deleteCredential(name: string): Promise<boolean> {
  const svc = serviceName(name);
  try {
    await execFileAsync('security', ['delete-generic-password', '-s', svc]);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all ink-namespaced credentials in the Keychain.
 * Returns metadata only — never the actual secret values.
 */
export async function listCredentials(): Promise<KeychainCredential[]> {
  try {
    const { stdout } = await execFileAsync('security', ['dump-keychain']);
    return parseKeychainDump(stdout);
  } catch {
    return [];
  }
}

function parseKeychainDump(dump: string): KeychainCredential[] {
  const results: KeychainCredential[] = [];
  const entries = dump.split(/^keychain:/gm);

  for (const entry of entries) {
    if (!entry.includes('class: "genp"')) continue;

    const svcMatch = entry.match(/"svce"<blob>="([^"]+)"/);
    if (!svcMatch) continue;

    const svc = svcMatch[1];
    if (!svc.startsWith(SERVICE_PREFIX)) continue;

    const name = svc.slice(SERVICE_PREFIX.length);
    const acctMatch = entry.match(/"acct"<blob>="([^"]+)"/);
    const label = acctMatch ? acctMatch[1] : name;

    const cdatMatch = entry.match(
      /"cdat"<timedate>=0x[0-9A-Fa-f]+\s+"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/
    );
    const mdatMatch = entry.match(
      /"mdat"<timedate>=0x[0-9A-Fa-f]+\s+"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/
    );

    const parseKeychainDate = (m: RegExpMatchArray | null): string | null => {
      if (!m) return null;
      return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    };

    results.push({
      name,
      label,
      createdAt: parseKeychainDate(cdatMatch),
      modifiedAt: parseKeychainDate(mdatMatch),
    });
  }

  return results;
}
