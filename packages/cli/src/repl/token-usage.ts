export interface ContextParts {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface BackendTokenUsage {
  backend: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /**
   * The context this request was handed, normalized per backend at the
   * adapter boundary. Anthropic bills input, cache reads and cache writes as
   * three disjoint parts of one prompt, so they sum; OpenAI's input_tokens and
   * Gemini's promptTokenCount already include their cached portion, so adding
   * cacheReadTokens there would double-count (Lumen, PR #583 finding 2).
   */
  contextTokens?: number;
  /**
   * The parts `contextTokens` was computed from — the FINAL request's own
   * input / cache read / cache write. Kept apart from the top-level fields,
   * which for an agent run are the run's aggregate (Lumen, PR #583 round 3).
   */
  contextParts?: ContextParts;
  source: 'json' | 'text';
  /**
   * Per-model breakdown as the backend reported it, keyed exactly as reported.
   * Carries the backend's own cost figure, which answers "what did this spend"
   * without a price table in our code. Keys are never merged here — a query can
   * list both a dated model id and its alias, and only the reporting layer has
   * the context to decide whether those are one model or two.
   */
  modelUsage?: Record<string, BackendModelUsage>;
  raw?: Record<string, unknown>;
}

/** One model's contribution to a turn, from the backend's own report. */
export interface BackendModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * The backend's own cost figure. OPTIONAL on purpose: a turn whose tokens
   * are readable but whose cost was not reported must not publish 0, or a
   * summed session cost under-reports with no way to tell a measured zero
   * from a never-reported one (Lumen, PR #500 round 2).
   */
  costUSD?: number;
  /**
   * True when at least one contribution to `costUSD` did not report a cost, so
   * the figure is a LOWER BOUND rather than the total. Without this, a mixed
   * run publishes a subtotal that reads as complete — the same false certainty
   * as a zero, one level up (Lumen, PR #500 round 3).
   */
  costPartial?: boolean;
  canonicalModel?: string;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^([\d,.]+)\s*([kKmM])?$/);
  if (!match) return undefined;

  const base = Number.parseFloat(match[1]!.replace(/,/g, ''));
  if (!Number.isFinite(base)) return undefined;

  const suffix = match[2]?.toLowerCase();
  if (suffix === 'k') return Math.round(base * 1_000);
  if (suffix === 'm') return Math.round(base * 1_000_000);
  return Math.round(base);
}

function pick(...values: Array<unknown>): number | undefined {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function normalizeUsageObject(
  obj: Record<string, unknown>
): Omit<BackendTokenUsage, 'backend' | 'source'> | null {
  // Gemini nests its counts under usageMetadata (Lumen, PR #576 round 7).
  const usageCandidate =
    (obj.usage as Record<string, unknown> | undefined) ||
    (obj.usageMetadata as Record<string, unknown> | undefined) ||
    obj;

  const inputTokens = pick(
    usageCandidate.input_tokens,
    usageCandidate.inputTokens,
    usageCandidate.prompt_tokens,
    usageCandidate.promptTokens,
    usageCandidate.promptTokenCount,
    (usageCandidate.input as Record<string, unknown> | undefined)?.tokens,
    (usageCandidate.prompt as Record<string, unknown> | undefined)?.tokens
  );

  const outputTokens = pick(
    usageCandidate.output_tokens,
    usageCandidate.outputTokens,
    usageCandidate.completion_tokens,
    usageCandidate.completionTokens,
    usageCandidate.candidatesTokenCount,
    (usageCandidate.output as Record<string, unknown> | undefined)?.tokens,
    (usageCandidate.completion as Record<string, unknown> | undefined)?.tokens
  );

  // Gemini reports totalTokenCount (prompt + candidates + thoughts).
  const totalTokens = pick(
    usageCandidate.total_tokens,
    usageCandidate.totalTokens,
    usageCandidate.totalTokenCount
  );

  const cacheReadTokens = pick(
    usageCandidate.cache_read_tokens,
    usageCandidate.cached_tokens,
    usageCandidate.cacheReadTokens,
    usageCandidate.cachedTokens,
    (usageCandidate.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens,
    (usageCandidate.cache as Record<string, unknown> | undefined)?.read_tokens
  );

  const cacheWriteTokens = pick(
    usageCandidate.cache_write_tokens,
    usageCandidate.cacheWriteTokens,
    (usageCandidate.cache as Record<string, unknown> | undefined)?.write_tokens
  );

  // Gemini counts thoughts APART from candidates; OpenAI's reasoning_tokens
  // are already inside output_tokens. Only the former adds to a synthesized
  // total (Lumen, PR #576 round 8).
  const separateThoughts = toNumber(usageCandidate.thoughtsTokenCount);
  const reasoningTokens = pick(
    usageCandidate.reasoning_tokens,
    usageCandidate.reasoningTokens,
    usageCandidate.thoughtsTokenCount,
    (usageCandidate.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens
  );

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    // A synthesized total keeps hidden reasoning — dropping it under-counts
    // the window by exactly the part the model does not show.
    totalTokens:
      totalTokens !== undefined
        ? totalTokens
        : inputTokens !== undefined && outputTokens !== undefined
          ? inputTokens + outputTokens + (separateThoughts ?? 0)
          : undefined,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  };
}

function parseJsonUsage(text: string): Omit<BackendTokenUsage, 'backend' | 'source'> | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith('{') && line.endsWith('}'));

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]!) as Record<string, unknown>;
      const normalized = normalizeUsageObject(parsed);
      if (normalized) {
        return { ...normalized, raw: parsed };
      }
    } catch {
      // Ignore parse failures.
    }
  }

  return null;
}

function parseTextUsage(text: string): Omit<BackendTokenUsage, 'backend' | 'source'> | null {
  const inputMatch =
    text.match(/(?:input|prompt)\s*(?:tokens?)?\s*[:=]\s*([\d.,]+(?:\s*[kKmM])?)/i) ||
    text.match(/([\d.,]+(?:\s*[kKmM])?)\s*(?:input|prompt)\s*tokens?/i);
  const outputMatch =
    text.match(
      /(?:output|completion|candidate)\s*(?:tokens?)?\s*[:=]\s*([\d.,]+(?:\s*[kKmM])?)/i
    ) || text.match(/([\d.,]+(?:\s*[kKmM])?)\s*(?:output|completion|candidate)\s*tokens?/i);
  const totalMatch =
    text.match(/(?:total|all)\s*(?:tokens?)?\s*[:=]\s*([\d.,]+(?:\s*[kKmM])?)/i) ||
    text.match(/([\d.,]+(?:\s*[kKmM])?)\s*total\s*tokens?/i);
  const cacheReadMatch = text.match(
    /(?:cache(?:d)?\s*(?:read|hit)?\s*tokens?)\s*[:=]\s*([\d.,]+(?:\s*[kKmM])?)/i
  );
  const cacheWriteMatch = text.match(
    /(?:cache\s*write\s*tokens?)\s*[:=]\s*([\d.,]+(?:\s*[kKmM])?)/i
  );
  const reasoningMatch = text.match(/(?:reasoning\s*tokens?)\s*[:=]\s*([\d.,]+(?:\s*[kKmM])?)/i);
  // Gemini's text summaries label thoughts apart from candidates; they add.
  const thoughtsMatch = text.match(/(?:thoughts?\s*tokens?)\s*[:=]\s*([\d.,]+(?:\s*[kKmM])?)/i);

  const inputTokens = pick(inputMatch?.[1]);
  const outputTokens = pick(outputMatch?.[1]);
  const totalTokens = pick(totalMatch?.[1]);
  const cacheReadTokens = pick(cacheReadMatch?.[1]);
  const cacheWriteTokens = pick(cacheWriteMatch?.[1]);
  const reasoningTokens = pick(reasoningMatch?.[1], thoughtsMatch?.[1]);
  const separateThoughts = pick(thoughtsMatch?.[1]);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens:
      totalTokens !== undefined
        ? totalTokens
        : inputTokens !== undefined && outputTokens !== undefined
          ? inputTokens + outputTokens + (separateThoughts ?? 0)
          : undefined,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  };
}

/** Backends whose prompt caching is reported as parts DISJOINT from input. */
const SUMMED_CACHE_BACKENDS = new Set(['claude', 'anthropic']);

/**
 * The context a request was handed, per that backend's own accounting.
 * Anthropic: input + cache read + cache write (disjoint parts of one prompt).
 * Everyone else (OpenAI, Gemini): input already includes the cached portion.
 */
export function providerContextTokens(
  backend: string,
  usage: Pick<BackendTokenUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>
): number | undefined {
  if (SUMMED_CACHE_BACKENDS.has(backend.toLowerCase())) {
    const parts = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].filter(
      (n): n is number => n !== undefined
    );
    return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : undefined;
  }
  return usage.inputTokens;
}

export function extractBackendTokenUsage(
  backend: string,
  stdout: string,
  stderr: string
): BackendTokenUsage | undefined {
  const combined = `${stdout || ''}\n${stderr || ''}`.trim();
  if (!combined) return undefined;

  const jsonUsage = parseJsonUsage(combined);
  const parsed: BackendTokenUsage | undefined = jsonUsage
    ? { backend, source: 'json', ...jsonUsage }
    : (() => {
        const textUsage = parseTextUsage(combined);
        return textUsage ? { backend, source: 'text', ...textUsage } : undefined;
      })();
  if (!parsed) return undefined;

  // A buffered report is one usage object, so its parts are the request's.
  const parts: ContextParts = {
    ...(parsed.inputTokens !== undefined ? { inputTokens: parsed.inputTokens } : {}),
    ...(parsed.cacheReadTokens !== undefined ? { cacheReadTokens: parsed.cacheReadTokens } : {}),
    ...(parsed.cacheWriteTokens !== undefined ? { cacheWriteTokens: parsed.cacheWriteTokens } : {}),
  };
  const contextTokens = providerContextTokens(backend, parts);
  return contextTokens === undefined ? parsed : { ...parsed, contextTokens, contextParts: parts };
}

export function formatBackendTokenUsage(usage: BackendTokenUsage): string {
  const parts: string[] = [];

  if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens.toLocaleString()}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens.toLocaleString()}`);
  if (usage.totalTokens !== undefined) parts.push(`total ${usage.totalTokens.toLocaleString()}`);
  if (usage.cacheReadTokens !== undefined)
    parts.push(`cache-read ${usage.cacheReadTokens.toLocaleString()}`);
  if (usage.cacheWriteTokens !== undefined)
    parts.push(`cache-write ${usage.cacheWriteTokens.toLocaleString()}`);
  if (usage.reasoningTokens !== undefined)
    parts.push(`reasoning ${usage.reasoningTokens.toLocaleString()}`);

  const details = parts.join(' · ');
  return details
    ? `${usage.backend} usage (${usage.source}): ${details}`
    : `${usage.backend} usage (${usage.source})`;
}
