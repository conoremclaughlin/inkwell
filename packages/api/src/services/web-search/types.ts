export interface WebSearchInput {
  query: string;
  maxResults: number;
  signal?: AbortSignal;
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
