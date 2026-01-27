/**
 * Secure Web Fetch
 *
 * Wraps web page content with security boundaries before returning to the agent.
 * This prevents prompt injection attacks from malicious web content.
 */

import { z } from 'zod';
import {
  wrapUntrustedData,
  sanitizeExtractedData,
} from '../../security/untrusted-data';
import {
  createSandboxedReader,
  type WebPageExtraction,
} from '../../security/sandboxed-reader';
import { logger } from '../../utils/logger';
import { getAuditService } from '../../services/audit';

// ============== Schemas ==============

export const secureWebFetchInputSchema = z.object({
  url: z.string().url().describe('The URL to fetch'),
  extractOnly: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, returns extraction prompt instead of wrapped content'),
  userId: z.string().uuid().optional().describe('User ID for audit logging'),
});

export type SecureWebFetchInput = z.infer<typeof secureWebFetchInputSchema>;

export interface SecureWebFetchResult {
  success: boolean;
  url: string;
  wrappedContent?: string;
  extractionPrompt?: string;
  error?: string;
  contentLength?: number;
  fetchedAt: string;
}

// ============== Core Function ==============

/**
 * Fetch a URL and wrap the content with security boundaries.
 *
 * This function is designed to be called by an MCP tool handler.
 * The actual HTTP fetch should be done by the caller (e.g., using
 * the backend's native fetch capabilities).
 *
 * @param rawHtml - The raw HTML content fetched from the URL
 * @param url - The source URL (for context)
 * @param options - Additional options
 */
export function wrapWebFetchContent(
  rawHtml: string,
  url: string,
  options?: {
    extractOnly?: boolean;
    userId?: string;
    maxLength?: number;
  }
): SecureWebFetchResult {
  const auditService = getAuditService();
  const maxLength = options?.maxLength ?? 100000; // 100KB default

  try {
    // Truncate if too large
    let content = rawHtml;
    let truncated = false;
    if (content.length > maxLength) {
      content = content.slice(0, maxLength);
      truncated = true;
      logger.warn('Web content truncated for security', {
        url,
        originalLength: rawHtml.length,
        truncatedLength: maxLength,
      });
    }

    // Log the fetch
    auditService.log({
      userId: options?.userId,
      action: 'web_fetch',
      category: 'network',
      target: url,
      responseStatus: 'success',
      responseSummary: `Fetched ${content.length} bytes${truncated ? ' (truncated)' : ''}`,
      metadata: { truncated, originalLength: rawHtml.length },
    });

    if (options?.extractOnly) {
      // Return extraction prompt for sandboxed processing
      const reader = createSandboxedReader({
        userId: options.userId,
        blockUrls: true,
        sanitizeOutput: true,
      });
      const extractionPrompt = reader.createWebPageExtractionPrompt(content, url);

      return {
        success: true,
        url,
        extractionPrompt,
        contentLength: content.length,
        fetchedAt: new Date().toISOString(),
      };
    }

    // Wrap content with security boundaries
    const wrappedContent = wrapUntrustedData(content, 'web_fetch', {
      context: `URL: ${url}${truncated ? ' (content truncated)' : ''}`,
    });

    return {
      success: true,
      url,
      wrappedContent,
      contentLength: content.length,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    auditService.log({
      userId: options?.userId,
      action: 'web_fetch',
      category: 'network',
      target: url,
      responseStatus: 'error',
      responseSummary: errorMessage,
    });

    return {
      success: false,
      url,
      error: errorMessage,
      fetchedAt: new Date().toISOString(),
    };
  }
}

// ============== Validation Helpers ==============

/**
 * Validate extracted web page data.
 * Call this after a sandboxed agent processes the extraction prompt.
 */
export function validateWebPageExtraction(
  extraction: WebPageExtraction,
  options?: { userId?: string }
): {
  valid: boolean;
  sanitized: WebPageExtraction;
  violations: string[];
} {
  const reader = createSandboxedReader({
    userId: options?.userId,
    blockUrls: true,
    sanitizeOutput: true,
  });

  return reader.validateExtraction(extraction as Record<string, unknown>, 'web_fetch') as {
    valid: boolean;
    sanitized: WebPageExtraction;
    violations: string[];
  };
}

/**
 * Sanitize a single string value from web content.
 */
export function sanitizeWebContent(content: string): string {
  return sanitizeExtractedData(content);
}

// ============== URL Safety Check ==============

const BLOCKED_URL_PATTERNS = [
  /^file:\/\//i, // Local files
  /^javascript:/i, // JavaScript URLs
  /^data:/i, // Data URLs (can be large/malicious)
  /localhost/i, // Localhost (unless explicitly allowed)
  /127\.0\.0\.1/, // Loopback
  /\[::1\]/, // IPv6 loopback
  /\.local$/i, // mDNS local domains
  /^https?:\/\/10\./, // Private network
  /^https?:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private network
  /^https?:\/\/192\.168\./, // Private network
];

/**
 * Check if a URL is safe to fetch.
 * Blocks local/private network addresses by default.
 */
export function isUrlSafeToFetch(
  url: string,
  options?: { allowLocalhost?: boolean; allowPrivateNetwork?: boolean }
): { safe: boolean; reason?: string } {
  try {
    const parsed = new URL(url);

    // Must be http or https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { safe: false, reason: `Unsupported protocol: ${parsed.protocol}` };
    }

    // Check blocked patterns
    for (const pattern of BLOCKED_URL_PATTERNS) {
      // Skip localhost check if allowed
      if (options?.allowLocalhost && pattern.source.includes('localhost')) {
        continue;
      }
      // Skip private network checks if allowed
      if (
        options?.allowPrivateNetwork &&
        (pattern.source.includes('10\\.') ||
          pattern.source.includes('172\\.') ||
          pattern.source.includes('192\\.168'))
      ) {
        continue;
      }

      if (pattern.test(url)) {
        return { safe: false, reason: `URL matches blocked pattern: ${pattern.source}` };
      }
    }

    return { safe: true };
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }
}
