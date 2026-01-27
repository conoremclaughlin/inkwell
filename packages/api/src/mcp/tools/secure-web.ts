/**
 * Secure Web Tools
 *
 * Re-exports secure web fetch and search functions.
 * Use these instead of raw fetch/search to protect against prompt injection.
 */

export {
  // Fetch
  wrapWebFetchContent,
  validateWebPageExtraction,
  sanitizeWebContent,
  isUrlSafeToFetch,
  secureWebFetchInputSchema,
  type SecureWebFetchInput,
  type SecureWebFetchResult,
} from './secure-web-fetch';

export {
  // Search
  wrapSearchResults,
  validateSearchExtraction,
  createSecureSearch,
  BraveSearchAdapter,
  secureWebSearchInputSchema,
  type SecureWebSearchInput,
  type SecureWebSearchResult,
  type SearchResult,
  type RawSearchResponse,
  type SearchBackendAdapter,
} from './secure-web-search';
