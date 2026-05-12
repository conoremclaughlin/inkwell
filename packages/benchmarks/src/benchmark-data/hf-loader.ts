import type { BenchmarkCase } from './datasets';

const HF_ROWS_ENDPOINT = 'https://datasets-server.huggingface.co/rows';

interface HfRowsResponse {
  rows?: Array<{ row?: Record<string, unknown> }>;
  error?: string;
}

interface HfDatasetConfig {
  repo: string;
  config: string;
  split: string;
  limit: number;
  queryField: string;
  positiveField: string;
  negativeField?: string;
  token?: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseHfDatasetConfig(): HfDatasetConfig {
  const repo = process.env.HF_DATASET_REPO;
  if (!repo) {
    throw new Error(
      'HF_DATASET_REPO is required when MEMORY_BENCHMARK_DATASET=hf (example: mteb/arguana)'
    );
  }

  return {
    repo,
    config: process.env.HF_DATASET_CONFIG || 'default',
    split: process.env.HF_DATASET_SPLIT || 'test',
    limit: parsePositiveInt(process.env.HF_DATASET_LIMIT, 50),
    queryField: process.env.HF_QUERY_FIELD || 'query',
    positiveField: process.env.HF_POSITIVE_FIELD || 'positive',
    negativeField: process.env.HF_NEGATIVE_FIELD || 'negative',
    token: process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN,
  };
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function extractTextValues(value: unknown): string[] {
  if (value == null) return [];

  const direct = asString(value);
  if (direct) return [direct];

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextValues(item));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const candidateKeys = ['text', 'content', 'passage', 'document', 'answer', 'value'];
    for (const key of candidateKeys) {
      const candidate = asString(obj[key]);
      if (candidate) return [candidate];
    }

    // Fallback: include primitive string values from object
    const primitiveStrings = Object.values(obj)
      .map((entry) => asString(entry))
      .filter((entry): entry is string => !!entry);
    if (primitiveStrings.length > 0) return primitiveStrings;
  }

  return [];
}

async function fetchRows(
  cfg: HfDatasetConfig,
  offset: number,
  length: number
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    dataset: cfg.repo,
    config: cfg.config,
    split: cfg.split,
    offset: String(offset),
    length: String(length),
  });

  const headers: Record<string, string> = {};
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

  const response = await fetch(`${HF_ROWS_ENDPOINT}?${params.toString()}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HF rows API failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as HfRowsResponse;
  if (data.error) throw new Error(`HF rows API error: ${data.error}`);
  return (data.rows || [])
    .map((entry) => entry.row || {})
    .filter((row) => Object.keys(row).length > 0);
}

function mapRowsToBenchmarkCases(
  rows: Record<string, unknown>[],
  cfg: HfDatasetConfig
): BenchmarkCase[] {
  const out: BenchmarkCase[] = [];
  const fallbackPositivePool = rows
    .map((row) => extractTextValues(row[cfg.positiveField])[0] || null)
    .filter((text): text is string => !!text);

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];

    const query = asString(row[cfg.queryField]);
    if (!query) continue;

    const positiveTexts = extractTextValues(row[cfg.positiveField]);
    if (positiveTexts.length === 0) continue;

    let negativeTexts = cfg.negativeField
      ? extractTextValues(row[cfg.negativeField]).filter((text) => text !== positiveTexts[0])
      : [];

    // If dataset does not provide explicit negatives, sample from other positives.
    if (negativeTexts.length === 0) {
      const candidates = fallbackPositivePool.filter(
        (text, idx) => idx !== i && text !== positiveTexts[0]
      );
      if (candidates.length > 0) {
        const start = i % candidates.length;
        const rotated = [...candidates.slice(start), ...candidates.slice(0, start)];
        negativeTexts = rotated.slice(0, 5);
      }
    }

    if (negativeTexts.length === 0) continue;

    const rowId = asString(row.id) || asString(row._id) || `${cfg.split}-${i}`;

    out.push({
      id: `hf-${i}-${rowId}`,
      query,
      targetContent: positiveTexts[0],
      distractors: negativeTexts.slice(0, 5),
      provenance: `hf:${cfg.repo}/${cfg.config}/${cfg.split}`,
    });
  }

  return out;
}

export async function loadHfBenchmarkDataset(): Promise<{
  cases: BenchmarkCase[];
  source: string;
}> {
  const cfg = parseHfDatasetConfig();

  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  const pageSize = Math.min(100, Math.max(1, cfg.limit));

  while (rows.length < cfg.limit) {
    const chunk = await fetchRows(cfg, offset, Math.min(pageSize, cfg.limit - rows.length));
    if (chunk.length === 0) break;
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    offset += chunk.length;
  }

  const cases = mapRowsToBenchmarkCases(rows, cfg);
  if (cases.length === 0) {
    throw new Error(
      `HF dataset loaded but produced 0 benchmark cases. Check field mapping: query=${cfg.queryField}, positive=${cfg.positiveField}, negative=${cfg.negativeField || '(disabled)'}.`
    );
  }

  return {
    cases,
    source: `hf:${cfg.repo}/${cfg.config}/${cfg.split}`,
  };
}
