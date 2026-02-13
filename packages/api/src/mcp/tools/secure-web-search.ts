/**
 * Secure Web Search
 *
 * Wraps search results with security boundaries before returning to the agent.
 * Designed to work with any search backend (Brave, Google, etc.).
 */

import { z } from 'zod';
import { wrapUntrustedData } from '../../security/untrusted-data';
import {
  createSandboxedReader,
  type SearchResultExtraction,
} from '../../security/sandboxed-reader';
import { logger } from '../../utils/logger';
import { getAuditService } from '../../services/audit';

// ============== Schemas ==============

export const secureWebSearchInputSchema = z.object({
  query: z.string().min(1).max(500).describe('The search query'),
  maxResults: z.number().int().min(1).max(20).optional().default(10),
  extractOnly: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, returns extraction prompt instead of wrapped results'),
  userId: z.string().uuid().optional().describe('User ID for audit logging'),
});

export type SecureWebSearchInput = z.infer<typeof secureWebSearchInputSchema>;

/**
 * A single search result from any search backend.
 * This is the common interface that different backends should map to.
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Optional: publication date */
  date?: string;
  /** Optional: source/domain */
  source?: string;
}

/**
 * Raw search response from a backend.
 */
export interface RawSearchResponse {
  query: string;
  results: SearchResult[];
  totalResults?: number;
  searchEngine?: string;
  /** Raw response if available for debugging */
  raw?: unknown;
}

export interface SecureWebSearchResult {
  success: boolean;
  query: string;
  wrappedResults?: string;
  extractionPrompt?: string;
  resultCount: number;
  error?: string;
  searchedAt: string;
}

// ============== Core Function ==============

/**
 * Wrap search results with security boundaries.
 *
 * This function is designed to be called after fetching results from
 * any search backend (Brave, Google, etc.). The caller is responsible
 * for the actual API call.
 *
 * @param response - The raw search response from the backend
 * @param options - Additional options
 */
export function wrapSearchResults(
  response: RawSearchResponse,
  options?: {
    extractOnly?: boolean;
    userId?: string;
    includeUrls?: boolean;
  }
): SecureWebSearchResult {
  const auditService = getAuditService();

  try {
    // Format results as readable text
    const formattedResults = formatSearchResults(response, {
      includeUrls: options?.includeUrls ?? false, // URLs stripped by default for safety
    });

    // Log the search
    auditService.log({
      userId: options?.userId,
      action: 'web_search',
      category: 'network',
      target: response.query,
      responseStatus: 'success',
      responseSummary: `Found ${response.results.length} results`,
      metadata: {
        searchEngine: response.searchEngine,
        resultCount: response.results.length,
      },
    });

    if (options?.extractOnly) {
      // Return extraction prompt for sandboxed processing
      const reader = createSandboxedReader({
        userId: options.userId,
        blockUrls: true,
        sanitizeOutput: true,
      });
      const extractionPrompt = reader.createSearchExtractionPrompt(
        formattedResults,
        response.query
      );

      return {
        success: true,
        query: response.query,
        extractionPrompt,
        resultCount: response.results.length,
        searchedAt: new Date().toISOString(),
      };
    }

    // Wrap results with security boundaries
    const wrappedResults = wrapUntrustedData(formattedResults, 'web_search', {
      context: `Query: "${response.query}" | Results: ${response.results.length}`,
    });

    return {
      success: true,
      query: response.query,
      wrappedResults,
      resultCount: response.results.length,
      searchedAt: new Date().toISOString(),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    auditService.log({
      userId: options?.userId,
      action: 'web_search',
      category: 'network',
      target: response.query,
      responseStatus: 'error',
      responseSummary: errorMessage,
    });

    return {
      success: false,
      query: response.query,
      error: errorMessage,
      resultCount: 0,
      searchedAt: new Date().toISOString(),
    };
  }
}

// ============== Formatting ==============

/**
 * Format search results as readable text.
 */
function formatSearchResults(
  response: RawSearchResponse,
  options?: { includeUrls?: boolean }
): string {
  const lines: string[] = [
    `Search Results for: "${response.query}"`,
    `Total Results: ${response.totalResults ?? response.results.length}`,
    response.searchEngine ? `Search Engine: ${response.searchEngine}` : '',
    '',
    '---',
    '',
  ].filter(Boolean);

  response.results.forEach((result, index) => {
    lines.push(`[${index + 1}] ${result.title}`);
    if (options?.includeUrls) {
      lines.push(`    URL: ${result.url}`);
    }
    if (result.source) {
      lines.push(`    Source: ${result.source}`);
    }
    if (result.date) {
      lines.push(`    Date: ${result.date}`);
    }
    lines.push(`    ${result.snippet}`);
    lines.push('');
  });

  return lines.join('\n');
}

// ============== Validation Helpers ==============

/**
 * Validate extracted search results.
 * Call this after a sandboxed agent processes the extraction prompt.
 */
export function validateSearchExtraction(
  extraction: SearchResultExtraction,
  options?: { userId?: string }
): {
  valid: boolean;
  sanitized: SearchResultExtraction;
  violations: string[];
} {
  const reader = createSandboxedReader({
    userId: options?.userId,
    blockUrls: true,
    sanitizeOutput: true,
  });

  return reader.validateExtraction(
    extraction as unknown as Record<string, unknown>,
    'web_search'
  ) as unknown as {
    valid: boolean;
    sanitized: SearchResultExtraction;
    violations: string[];
  };
}

// ============== Backend Adapters ==============

/**
 * Adapter interface for different search backends.
 * Implement this to add support for new search engines.
 */
export interface SearchBackendAdapter {
  readonly name: string;

  /**
   * Execute a search and return normalized results.
   */
  search(query: string, options?: { maxResults?: number }): Promise<RawSearchResponse>;
}

/**
 * Placeholder for Brave Search adapter.
 * The actual implementation would use the Brave Search API.
 */
export class BraveSearchAdapter implements SearchBackendAdapter {
  readonly name = 'brave';

  // API key stored for future implementation
  constructor(_apiKey?: string) {
    // _apiKey will be used once actual API implementation is added
  }

  async search(query: string, _options?: { maxResults?: number }): Promise<RawSearchResponse> {
    // TODO: Implement Brave Search API call
    // This is a placeholder - actual implementation would:
    // 1. Call https://api.search.brave.com/res/v1/web/search
    // 2. Map response to SearchResult[]
    // 3. Return normalized RawSearchResponse

    logger.warn('BraveSearchAdapter.search called but not implemented', { query });

    return {
      query,
      results: [],
      searchEngine: 'brave',
    };
  }
}

/**
 * Create a secure search function with a specific backend.
 */
export function createSecureSearch(adapter: SearchBackendAdapter) {
  return async function secureSearch(
    query: string,
    options?: {
      maxResults?: number;
      extractOnly?: boolean;
      userId?: string;
      includeUrls?: boolean;
    }
  ): Promise<SecureWebSearchResult> {
    const response = await adapter.search(query, { maxResults: options?.maxResults });
    return wrapSearchResults(response, options);
  };
}
