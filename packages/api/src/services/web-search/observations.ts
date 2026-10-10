import { LIMITS } from './config.js';

const QUERY_RECORDS = LIMITS.searches + 1; // retain the first over-limit/rejected attempt
const HIT_RECORDS = LIMITS.results;

export interface SearchObservationSnapshot {
  kind: 'unvalidated-stream-observations';
  /** Decode a stored field as JSON string content to recover its exact prefix. */
  textEncoding?: 'json-string-content';
  queryCount: number;
  hitCount: number;
  truncated: boolean;
  malformedLines: number;
  queries?: Array<{ query: string; truncated: boolean }>;
  hits?: Array<{ title: string; url: string; truncated: boolean }>;
}

// JSONB cannot store NUL or unpaired UTF-16 surrogates. Escape exactly as JSON
// string content (including backslashes), so malicious fields remain recoverable
// forensic data rather than making the required database write unrepresentable.
const encodeText = (text: string): string => JSON.stringify(text).slice(1, -1);

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Account-level forensic hints, NEVER search evidence or parser authority.
 * Receives only runBounded's already byte-bounded inference lines; no rebuffering
 * or provider prose/auth/stderr collection. Content-off never retains raw fields.
 */
export class SearchObservations {
  private readonly data: SearchObservationSnapshot;
  constructor(private readonly contentRecording: boolean) {
    this.data = {
      kind: 'unvalidated-stream-observations',
      queryCount: 0,
      hitCount: 0,
      truncated: false,
      malformedLines: 0,
      ...(contentRecording && { textEncoding: 'json-string-content', queries: [], hits: [] }),
    };
  }

  observe(line: string): void {
    let event: Record<string, unknown> | undefined;
    try {
      event = object(JSON.parse(line));
    } catch {
      this.data.malformedLines++;
      return;
    }
    if (!event) return;
    if (event.type === 'assistant') {
      const blocks = object(event.message)?.content;
      if (!Array.isArray(blocks)) return;
      for (const value of blocks) {
        const block = object(value);
        if (block?.type !== 'tool_use' || block.name !== 'WebSearch') continue;
        this.data.queryCount++;
        const query = object(block.input)?.query;
        if (typeof query !== 'string') {
          this.data.truncated = true;
          continue;
        }
        const truncated = query.length > LIMITS.queryChars;
        this.data.truncated ||= truncated || this.data.queryCount > QUERY_RECORDS;
        if (this.contentRecording && this.data.queries!.length < QUERY_RECORDS)
          this.data.queries!.push({
            query: encodeText(query.slice(0, LIMITS.queryChars)),
            truncated,
          });
      }
    } else if (event.type === 'user') {
      // Native structured result fields only, not model/user display prose.
      const groups = object(event.tool_use_result)?.results;
      if (!Array.isArray(groups)) return;
      for (const group of groups) {
        const hits = object(group)?.content;
        if (!Array.isArray(hits)) continue;
        for (const value of hits) {
          const hit = object(value);
          if (!hit || typeof hit.title !== 'string' || typeof hit.url !== 'string') continue;
          this.data.hitCount++;
          const truncated = hit.title.length > 500 || hit.url.length > 2048;
          this.data.truncated ||= truncated || this.data.hitCount > HIT_RECORDS;
          if (this.contentRecording && this.data.hits!.length < HIT_RECORDS)
            this.data.hits!.push({
              title: encodeText(hit.title.slice(0, 500)),
              url: encodeText(hit.url.slice(0, 2048)),
              truncated,
            });
        }
      }
    }
  }

  snapshot(): SearchObservationSnapshot {
    return {
      ...this.data,
      ...(this.data.queries && { queries: this.data.queries.map((item) => ({ ...item })) }),
      ...(this.data.hits && { hits: this.data.hits.map((item) => ({ ...item })) }),
    };
  }
}
