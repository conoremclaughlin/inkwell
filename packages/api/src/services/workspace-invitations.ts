/**
 * Invitations to join a group (ink://designs/inkling-workspace-invitations).
 *
 * Both kinds share one secret format: ten characters of Crockford base32
 * (about 50 bits), shown as two groups of five so a person can read it aloud
 * or type it. Only its SHA-256 is stored. Joining goes through the database
 * function accept_workspace_invitation (migration 20261006214500), which is
 * the only place membership is granted this way.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { FixedWindowLimiter } from '../utils/fixed-window-limiter';

/** Crockford's base32: no I, L, O or U, so nothing reads as another letter. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;

/** A fresh invitation code, as it is shown: `K7QF2-M9XRT`. */
export function newInvitationCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * What a person typed or pasted, as the ten characters it stands for, or null
 * if it can't be a code. Case, spaces and dashes don't matter, and the letters
 * people confuse with digits (O, I, L) read as 0 and 1, as Crockford intends.
 */
export function normalizeInvitationCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null;
  return cleaned;
}

/** What is stored and looked up: never the code itself. */
export function invitationDigest(normalizedCode: string): string {
  return createHash('sha256').update(normalizedCode, 'utf8').digest('hex');
}

export type InvitationStatus = 'pending' | 'revoked' | 'expired' | 'used';

export interface InvitationRow {
  kind: string;
  revoked_at: string | null;
  expires_at: string;
  max_uses: number | null;
  use_count: number;
}

/** How an invitation stands now, for the people who manage the group. */
export function invitationStatus(row: InvitationRow, now = Date.now()): InvitationStatus {
  if (row.revoked_at) return 'revoked';
  if (row.max_uses !== null && row.use_count >= row.max_uses) return 'used';
  if (Date.parse(row.expires_at) <= now) return 'expired';
  return 'pending';
}

/**
 * How many codes one account may try in a window, before it is told to wait.
 * Per process, like the turn registry: a restart forgets it. Fixed windows
 * whose memory is bounded and pruned (FixedWindowLimiter), so accounts that
 * stopped trying aren't kept. Fifty bits of code against twenty tries in ten
 * minutes leaves guessing hopeless.
 */
export class InvitationAttemptLimiter {
  private windows: FixedWindowLimiter;

  constructor(
    private readonly limit = 20,
    private readonly windowMs = 10 * 60 * 1000
  ) {
    this.windows = new FixedWindowLimiter(windowMs);
  }

  /** Records an attempt by `accountId`; false if it is over the limit. */
  allow(accountId: string, now = Date.now()): boolean {
    return !this.windows.hit(accountId, this.limit, now);
  }

  /** Test seam. */
  reset(): void {
    this.windows = new FixedWindowLimiter(this.windowMs);
  }
}

export const invitationAttempts = new InvitationAttemptLimiter();

/** What a group's display name may be. */
export const MAX_WORKSPACE_NAME_LENGTH = 80;

/** A usable group name, trimmed, or null. */
export function workspaceNameFrom(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.trim();
  if (!name || [...name].length > MAX_WORKSPACE_NAME_LENGTH) return null;
  return name;
}

/**
 * Whether this server may honour invitations addressed to an email address.
 * Matching the signed-in account's email is only proof the person controls
 * that address if sign-up confirmed it, and a local server skips confirmation.
 * So the operator says so explicitly (INVITE_EMAIL_OWNERSHIP_CONFIRMED=true);
 * without it, email invitations are refused and shareable codes still work.
 */
export function emailInvitesHonoured(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.INVITE_EMAIL_OWNERSHIP_CONFIRMED === 'true';
}

/** Marks a group created to take members only by invitation (limit B). */
export const INVITE_ONLY = 'invite_only';

export function isInviteOnly(metadata: unknown): boolean {
  return (metadata as { membershipMode?: unknown } | null)?.membershipMode === INVITE_ONLY;
}

/**
 * A group's slug with a short random suffix, for when its plain slug is taken.
 * A group's name needn't be unique (a group called "Personal" beside the
 * person's own space, or a second "The Smiths"), but an owner's slugs are.
 */
export function suffixedGroupSlug(slug: string): string {
  return `${slug.slice(0, 57)}-${randomBytes(3).toString('hex')}`;
}
