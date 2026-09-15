import path from 'path';

/** A studio/SB name is one component, never a path or a git option. */
export function isSafeStudioComponent(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[a-zA-Z0-9]/.test(value) &&
    !/[^a-zA-Z0-9._-]/.test(value)
  );
}

/**
 * Durable studios live beside the explicitly selected repository. Reject bad
 * names rather than normalizing traversal into some other studio's identity.
 * The repository root is operator-selected, not supplied by a chat message.
 */
export function studioSiblingPath(repoRoot: string, slug: string): string {
  // A derived slug can include the repository's own basename (including
  // spaces or Unicode). Only its component boundary matters here.
  if (!slug || slug === '.' || slug === '..' || /[/\\\0\r\n]/.test(slug)) {
    throw new Error('Invalid studio path component');
  }
  const mainRoot = path.resolve(repoRoot);
  return path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}--${slug}`);
}
