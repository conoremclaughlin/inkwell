/**
 * The uploads root this process checked at startup, or null: uploads are off
 * until server.ts has run prepareUploadsRoot and the root passed its
 * placement check (layout.ts says what that does and does not cover). Read
 * by the upload routes and by the trigger media resolver; nothing else sets
 * it.
 */

let rootReal: string | null = null;

export function setUploadsRoot(root: string | null): void {
  rootReal = root;
}

export function uploadsRoot(): string | null {
  return rootReal;
}

/**
 * How long a claimed upload stays readable, counted from its claim: null, no
 * automatic expiry, until a retention policy is chosen. The one place the
 * routes and trigger dispatch both read it from, so they cannot disagree.
 */
export function uploadsRetentionMs(): number | null {
  return null;
}
