export interface BackendTokenUsage {
  backend: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  source: 'json' | 'text';
  raw?: Record<string, unknown>;
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

function normalizeUsageObject(obj: Record<string, unknown>): Omit<BackendTokenUsage, 'backend' | 'source'> | null {
  const usageCandidate = (obj.usage as Record<string, unknown> | undefined) || obj;

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

  const totalTokens = pick(usageCandidate.total_tokens, usageCandidate.totalTokens);

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

  const reasoningTokens = pick(
    usageCandidate.reasoning_tokens,
    usageCandidate.reasoningTokens,
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
    totalTokens:
      totalTokens !== undefined
        ? totalTokens
        : inputTokens !== undefined && outputTokens !== undefined
          ? inputTokens + outputTokens
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
    text.match(/(?:output|completion|candidate)\s*(?:tokens?)?\s*[:=]\s*([\d.,]+(?:\s*[kKmM])?)/i) ||
    text.match(/([\d.,]+(?:\s*[kKmM])?)\s*(?:output|completion|candidate)\s*tokens?/i);
  const totalMatch =
    text.match(/(?:total|all)\s*(?:tokens?)?\s*[:=]\s*([\d.,]+(?:\s*[kKmM])?)/i) ||
    text.match(/([\d.,]+(?:\s*[kKmM])?)\s*total\s*tokens?/i);
  const cacheReadMatch = text.match(/(?:cache(?:d)?\s*(?:read|hit)?\s*tokens?)\s*[:=]\s*([\d.,]+(?:\s*[kKmM])?)/i);
  const cacheWriteMatch = text.match(/(?:cache\s*write\s*tokens?)\s*[:=]\s*([\d.,]+(?:\s*[kKmM])?)/i);
  const reasoningMatch = text.match(/(?:reasoning\s*tokens?)\s*[:=]\s*([\d.,]+(?:\s*[kKmM])?)/i);

  const inputTokens = pick(inputMatch?.[1]);
  const outputTokens = pick(outputMatch?.[1]);
  const totalTokens = pick(totalMatch?.[1]);
  const cacheReadTokens = pick(cacheReadMatch?.[1]);
  const cacheWriteTokens = pick(cacheWriteMatch?.[1]);
  const reasoningTokens = pick(reasoningMatch?.[1]);

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
          ? inputTokens + outputTokens
          : undefined,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  };
}

export function extractBackendTokenUsage(
  backend: string,
  stdout: string,
  stderr: string
): BackendTokenUsage | undefined {
  const combined = `${stdout || ''}\n${stderr || ''}`.trim();
  if (!combined) return undefined;

  const jsonUsage = parseJsonUsage(combined);
  if (jsonUsage) {
    return {
      backend,
      source: 'json',
      ...jsonUsage,
    };
  }

  const textUsage = parseTextUsage(combined);
  if (textUsage) {
    return {
      backend,
      source: 'text',
      ...textUsage,
    };
  }

  return undefined;
}

export function formatBackendTokenUsage(usage: BackendTokenUsage): string {
  const parts: string[] = [];

  if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens.toLocaleString()}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens.toLocaleString()}`);
  if (usage.totalTokens !== undefined) parts.push(`total ${usage.totalTokens.toLocaleString()}`);
  if (usage.cacheReadTokens !== undefined) parts.push(`cache-read ${usage.cacheReadTokens.toLocaleString()}`);
  if (usage.cacheWriteTokens !== undefined) parts.push(`cache-write ${usage.cacheWriteTokens.toLocaleString()}`);
  if (usage.reasoningTokens !== undefined) parts.push(`reasoning ${usage.reasoningTokens.toLocaleString()}`);

  const details = parts.join(' · ');
  return details ? `${usage.backend} usage (${usage.source}): ${details}` : `${usage.backend} usage (${usage.source})`;
}
