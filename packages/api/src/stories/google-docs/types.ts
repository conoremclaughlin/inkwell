/**
 * Google Docs Types
 *
 * Type definitions for Docs API interactions.
 */

export interface DocumentSummary {
  documentId: string;
  title: string;
  url: string;
  /** Most recent revision id, if returned by the API */
  revisionId?: string;
}

export interface DocumentContent extends DocumentSummary {
  /**
   * Plain-text rendering of the document body. Tables, images, and
   * formatting are flattened — this is intended for AI consumption,
   * not exact reproduction.
   */
  text: string;
}

export interface CreateDocumentOptions {
  title: string;
  /** Optional initial body text, inserted at index 1. */
  initialContent?: string;
}

export interface GetDocumentOptions {
  documentId: string;
}

export interface AppendTextOptions {
  documentId: string;
  text: string;
  /** Insert a leading newline so the appended text starts on a new line. Defaults to true. */
  separateWithNewline?: boolean;
}

export interface ReplaceTextOptions {
  documentId: string;
  /** Substring to replace */
  find: string;
  /** Replacement text */
  replaceWith: string;
  /** Defaults to true */
  matchCase?: boolean;
}

export interface ReplaceTextResult {
  documentId: string;
  occurrencesChanged: number;
}

/**
 * Docs operations subject to allowlist/blocklist enforcement.
 * Wholesale destructive operations are intentionally absent.
 */
export type DocsOperation =
  | 'create_document'
  | 'append_text'
  | 'replace_text'
  | 'delete_content_range'
  | 'delete_document';
