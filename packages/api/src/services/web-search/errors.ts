export const WEB_SEARCH_REASONS = [
  'disabled',
  'invalid_input',
  'missing_configuration',
  'unsupported_provider',
  'unsupported_credential',
  'unsupported_platform',
  'unsupported_capability',
  'managed_configuration',
  'capacity_exhausted',
  'service_quarantined',
  'cancelled',
  'timeout',
  'output_limit',
  'spawn_failed',
  'provider_failed',
  'rate_limited',
  'invalid_output',
  'search_not_observed',
  'stop_unconfirmed',
  'cleanup_failed',
  'internal_error',
] as const;

export type WebSearchReason = (typeof WEB_SEARCH_REASONS)[number];

/** No provider text, paths, queries, credentials, or nested causes cross this boundary. */
export class WebSearchError extends Error {
  readonly reason: WebSearchReason;

  /** Credentialed dispatch was attempted; not proof a search completed. */
  readonly launched: boolean;

  // Unknown/new callers are conservative. Only searchWeb can prove preflight.
  constructor(reason: WebSearchReason, launched = true) {
    // Also guard callers using untyped JavaScript.
    const safeReason = WEB_SEARCH_REASONS.includes(reason) ? reason : 'internal_error';
    super(`Web search refused: ${safeReason}`);
    this.name = 'WebSearchError';
    this.reason = safeReason;
    this.launched = launched;
  }
}

export function staticError(error: unknown): WebSearchError {
  return error instanceof WebSearchError ? error : new WebSearchError('internal_error');
}
