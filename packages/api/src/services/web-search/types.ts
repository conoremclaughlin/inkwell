export interface WebSearchInput {
  query: string;
  maxResults: number;
  signal?: AbortSignal;
}

/** Internal provider batch, after each caller's account permission and audit. */
export interface WebSearchBatchInput {
  queries: string[];
  maxResults: number;
  signal?: AbortSignal;
}

export type WebSearchBatchItem =
  | { query: string; success: true; results: WebSearchOutput['results'] }
  | {
      query: string;
      success: false;
      reason: 'search_not_observed';
      searchMayHaveRun: true;
    };

export interface WebSearchBatchOutput {
  provider: 'claude';
  model: string;
  items: WebSearchBatchItem[];
  searchQueries: string[];
  modelToolCallCount: number;
  /** Omitted if any completed native call did not report its own count. */
  nativeSearchCount?: number;
  usage?: WebSearchOutput['usage'];
}

export interface WebSearchOutput {
  provider: 'claude' | 'codex';
  model: string;
  /** Claude's native result schema has no snippets; this adapter returns ''. */
  results: Array<{ title: string; url: string; snippet: string }>;
  /** Observed WebSearch tool inputs, never the assistant's claimed search history. */
  searchQueries: string[];
  usage?: { inputTokens?: number; outputTokens?: number };
}
