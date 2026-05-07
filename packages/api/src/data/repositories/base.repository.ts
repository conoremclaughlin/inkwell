import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';

export abstract class BaseRepository {
  protected client: SupabaseClient<any>;

  constructor(client: SupabaseClient<any>) {
    this.client = client;
  }

  protected handleError(error: unknown, operation: string): never {
    logger.error(`Repository error during ${operation}:`, error);
    throw error;
  }

  /**
   * Attach the HTTP status from a Supabase response to its PostgrestError
   * before rethrowing. Without this, `PostgrestError` only carries
   * `{ message, details, hint, code }` — the 503 / 429 that a retry helper
   * needs to classify an error as transient gets stripped at the destructure
   * boundary. Callers that rethrow errors they intend to be retried should
   * route through this helper.
   */
  protected preserveStatus<E>(error: E, status: number | undefined): E {
    if (error && typeof error === 'object' && status !== undefined) {
      const errObj = error as Record<string, unknown>;
      if (errObj.status === undefined) errObj.status = status;
    }
    return error;
  }
}
