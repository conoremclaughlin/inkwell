const LEGACY_DOC_TITLE_RE = /^\s*#\s+[A-Za-z0-9_-]+\.md(?:\s*[-:]\s*.*)?\s*\n+/i;

/**
 * Remove legacy "*.md" title headers from constitution.
 * Older content uses headers like "# USER.md - About Our Human" or "# SOUL.md - Lumen".
 * Strip these so the UI renders clean titles.
 */
export function normalizeDocMarkdown(markdown?: string): string {
  if (!markdown) return '';
  return markdown.replace(LEGACY_DOC_TITLE_RE, '').trimStart();
}
