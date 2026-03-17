-- Benchmark persistence for memory recall quality tracking over time.

CREATE TABLE IF NOT EXISTS public.memory_recall_benchmark_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  dataset text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  embeddings_enabled boolean NOT NULL DEFAULT false,
  top_k integer NOT NULL DEFAULT 5,
  case_count integer NOT NULL DEFAULT 0,
  modes text[] NOT NULL DEFAULT '{}'::text[],
  summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.memory_recall_benchmark_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL REFERENCES public.memory_recall_benchmark_runs(run_id) ON DELETE CASCADE,
  mode text NOT NULL,
  cases integer NOT NULL,
  recall_at_1 double precision NOT NULL,
  recall_at_3 double precision NOT NULL,
  recall_at_5 double precision NOT NULL,
  mrr double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, mode)
);

CREATE TABLE IF NOT EXISTS public.memory_recall_benchmark_case_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL REFERENCES public.memory_recall_benchmark_runs(run_id) ON DELETE CASCADE,
  case_id text NOT NULL,
  mode text NOT NULL,
  query text NOT NULL,
  rank integer,
  top_summaries jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, case_id, mode)
);

CREATE INDEX IF NOT EXISTS idx_memory_recall_benchmark_runs_user_created
  ON public.memory_recall_benchmark_runs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_recall_benchmark_metrics_run
  ON public.memory_recall_benchmark_metrics (run_id, mode);

CREATE INDEX IF NOT EXISTS idx_memory_recall_benchmark_case_results_run
  ON public.memory_recall_benchmark_case_results (run_id, mode);
