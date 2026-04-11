export interface BenchmarkCase {
  id: string;
  query: string;
  targetContent?: string;
  targetContents?: string[];
  distractors: string[];
  provenance?: string;
}

export interface BootstrapRelevanceCase {
  id: string;
  threadKey: string;
  focusText: string;
  targetTopicKey: string;
  targetContent: string;
  distractors: string[];
  provenance?: string;
}

export const SMOKE_GOLDSET_V1: BenchmarkCase[] = [
  {
    id: 'exact-key-topic',
    query: 'decision:jwt-auth',
    targetContent:
      'We adopted decision:jwt-auth. Access tokens are RS256-signed and refreshed with rotating key IDs.',
    distractors: [
      'We discussed OAuth providers but did not finalize key rotation policy.',
      'JWT expiration defaults to 15 minutes for web sessions.',
      'Session middleware now logs token parsing warnings.',
    ],
  },
  {
    id: 'semantic-paraphrase-rls',
    query: 'server-side access bypasses row-level security with service role',
    targetContent:
      'PCP backend queries run with Supabase service role. RLS is bypassed server-side; authorization is enforced in app middleware.',
    distractors: [
      'Frontend queries should not use supabase-js for data access.',
      'RLS policies exist but are not the primary security boundary in this architecture.',
      'Session auth now uses persistSession false to avoid accidental JWT bleed.',
    ],
  },
  {
    id: 'hybrid-keyword-and-concept',
    query: 'pgvector cosine search for memory recall',
    targetContent:
      'Memory recall uses pgvector cosine similarity via match_memories RPC and an HNSW index on memories.embedding.',
    distractors: [
      'Vector dimensions are currently fixed at 1024 in schema.',
      'Recall supports topic filtering and salience filters.',
      'Search links endpoint remains text-based.',
    ],
  },
  {
    id: 'paraphrase-embedding-router',
    query: 'fallback from local model to hosted embeddings provider',
    targetContent:
      'Embedding router prefers Ollama locally and falls back to OpenAI when configured if local provider fails.',
    distractors: [
      'Model vetting metadata includes provider, dimensions, and notes.',
      'Ollama endpoint default is http://127.0.0.1:11434.',
      'OpenAI embeddings can be requested with explicit dimensions.',
    ],
  },
];

// Curated from existing Lumen + Wren memories:
// conventions, architecture decisions, process practices, and collaboration lessons.
// No direct PII (emails/IDs/phone numbers/URLs) is included.
export const INTERNAL_GOLDSET_V1: BenchmarkCase[] = [
  {
    id: 'github-review-surface',
    query: 'why should SBs use get_comments instead of get_reviews for pull requests',
    targetContent:
      'Because SB reviews are posted under one shared GitHub account, get_reviews appears as self-review noise. Use get_comments or review comments to capture real cross-SB feedback.',
    distractors: [
      'Always request a sibling review before merging.',
      'Use merge commits instead of squash for clearer history.',
      'Prefer GitHub MCP tools over raw gh CLI commands.',
    ],
    provenance: 'memory:43b926d3-4ae0-47b2-9731-b02d97a069fb (wren, convention:github-pr-reviews)',
  },
  {
    id: 'constitution-canonical-storage',
    query: 'where is the canonical storage for SOUL, IDENTITY, VALUES, and PROCESS documents',
    targetContent:
      'Constitution documents are canonical in the database. Agent-level documents live in agent_identities, while shared values and process live in workspace or user identity records.',
    distractors: [
      'The filesystem under ~/.pcp acts as cache and bootstrap fallback.',
      'Use bootstrap first in every session to hydrate identity and context.',
      'Identity files should not be committed into the repository.',
    ],
    provenance:
      'memory:ab767eac-5119-4d4d-8ff9-09772872e493 (wren, convention:constitution-storage)',
  },
  {
    id: 'studio-routing-cascade',
    query: 'how does studio routing resolve between override and default home',
    targetContent:
      'Studio routing follows a cascade: work-specific override first, then agent home studio_hint, then fallback to home.',
    distractors: [
      'Thread keys keep multi-step conversations in one logical session.',
      'Session lifecycle and phase are orthogonal state dimensions.',
      'Workspace IDs should be persisted for parallel worktrees.',
    ],
    provenance: 'memory:c92b5753-c9b2-4393-8b45-593fbcda7134 (wren, decision:studio-routing)',
  },
  {
    id: 'memory-design-philosophy',
    query: 'why embed topic organization inside remember call',
    targetContent:
      'Topic organization should be embedded in remember itself so agents do not need extra tools. Background normalization can happen asynchronously in a memory bridge.',
    distractors: [
      'Summaries can be generated later if not supplied at write time.',
      'Salience controls bootstrap prioritization of memories.',
      'Topic keys follow type:identifier convention.',
    ],
    provenance:
      'memory:e70e2bb8-a990-4ace-816d-c11fc1c83281 (wren, decision:memory-design-philosophy)',
  },
  {
    id: 'hierarchical-memory-architecture',
    query: 'what did phase 1 of hierarchical memory add to bootstrap',
    targetContent:
      'Phase 1 added summary and topicKey fields to remember and replaced flat recent-memory injection with a budget-constrained, topic-grouped knowledge summary at bootstrap.',
    distractors: [
      'High memories can be selected by recency windows.',
      'Critical memories should preserve richer detail.',
      'Knowledge summaries can be cached and invalidated on writes.',
    ],
    provenance: 'memory:e770da50-5afc-4b99-b9a1-da012eebfdd2 (wren, project:pcp/memory)',
  },
  {
    id: 'skills-policy-unification',
    query: 'how should skills and tools share authorization policy logic',
    targetContent:
      'Skills should flow through the same policy pipeline as tools with provenance metadata rather than separate allow/deny gates.',
    distractors: [
      'Skill manifests can include MCP server declarations.',
      'Skill discovery supports multiple source tiers with precedence.',
      'Per-backend adapters can render skills differently.',
    ],
    provenance:
      'memory:a6ea834f-1066-4a16-9e6c-aa9cd68e629c (wren, decision:skill-tool-unification)',
  },
  {
    id: 'session-model-structural-vs-narrative',
    query: 'what is the boundary between sessions and memories',
    targetContent:
      'Sessions are structural runtime state (presence, phase, context handles), while memories are narrative context (decisions, blockers, outcomes).',
    distractors: [
      'Phase transitions can auto-create high-salience memories.',
      'Lifecycle values include running, idle, completed, and failed.',
      'Session IDs can be reused for resumable workflows.',
    ],
    provenance:
      'wren process convention: sessions are structural state; memories are narrative context',
  },
  {
    id: 'no-push-main-preference',
    query: 'what is the repository preference about pushing directly to main',
    targetContent:
      'Never push directly to main from feature work. Use branch plus pull request flow even for small changes.',
    distractors: [
      'Commit messages should be clear and concise.',
      'Review comments should include actionable feedback.',
      'Use thread keys when coordinating PR reviews.',
    ],
    provenance: 'wren convention: never push directly to main; use branch + PR flow',
  },
  {
    id: 'multi-turn-tool-loop',
    query: 'how does sb chat continue reasoning after tool execution',
    targetContent:
      'In local tool routing mode, sb executes emitted tool calls and feeds tool results back to the backend in a continuation loop until no calls remain or the iteration cap is reached.',
    distractors: [
      'Tool execution should use authenticated MCP calls.',
      'Backend session IDs should be tracked for resume.',
      'Transport errors must be surfaced for debugging.',
    ],
    provenance: 'memory:0afee02c-69bf-4b64-bbfa-cb5918f0a666 (wren, project:pcp/sb-runtime)',
  },
  {
    id: 'hybrid-recall-need',
    query: 'why combine key matching and embeddings for memory recall',
    targetContent:
      'Hybrid recall is needed because lexical keys and semantic similarity capture different relevance signals. Union plus reranking improves recall robustness.',
    distractors: [
      'Pure text retrieval often misses paraphrased queries.',
      'Semantic retrieval can retrieve near but less precise matches.',
      'Benchmarking with recall@k and MRR tracks retrieval quality over time.',
    ],
    provenance:
      'memory:6fc804d1-aee2-4f0c-9461-acd7f52dd26f + memory:99753172-7bce-4dbf-97d2-0178a35afd49 (lumen, project:pcp/memory-benchmark)',
  },
];

export function getBenchmarkDataset(dataset: string): BenchmarkCase[] {
  if (dataset === 'smoke-v1') return SMOKE_GOLDSET_V1;
  if (dataset === 'internal-gold-v1') return INTERNAL_GOLDSET_V1;
  throw new Error(
    `Unknown benchmark dataset "${dataset}". Supported datasets: smoke-v1, internal-gold-v1`
  );
}

export const BOOTSTRAP_RELEVANCE_V1: BootstrapRelevanceCase[] = [
  {
    id: 'pr-thread-prioritization',
    threadKey: 'pr:204',
    focusText: 'review latest PR fixes and merge readiness',
    targetTopicKey: 'pr:204',
    targetContent:
      'PR #204 re-review checklist: verify blocker fixes, confirm test green status, and post merge-ready verdict.',
    distractors: [
      'PR #199 review covered media callback propagation and sent-count correctness.',
      'Studio routing decision uses home fallback when no explicit studio is provided.',
      'Constitution storage is canonical in DB, not local files.',
    ],
    provenance: 'memory:7bea0871-4051-4e8b-9b14-d12da727c528 (lumen, pr:204)',
  },
  {
    id: 'convention-thread-prioritization',
    threadKey: 'convention:github-pr-reviews',
    focusText: 'how review comments should be collected for sibling SBs',
    targetTopicKey: 'convention:github-pr-reviews',
    targetContent:
      'Use get_comments/get_review_comments for PR review retrieval since shared account usage makes get_reviews noisy.',
    distractors: [
      'Hybrid recall combines lexical and semantic signals for robust retrieval.',
      'Memory benchmark runs persist recall@k and MRR into dedicated tables.',
      'Agent studio hints route reminders to the correct home studio.',
    ],
    provenance: 'memory:43b926d3-4ae0-47b2-9731-b02d97a069fb (wren, convention:github-pr-reviews)',
  },
  {
    id: 'decision-thread-prioritization',
    threadKey: 'decision:studio-routing',
    focusText: 'select studio cascade rules for task execution',
    targetTopicKey: 'decision:studio-routing',
    targetContent:
      'Studio routing cascade: explicit override first, then agent home studio_hint, then fallback to home.',
    distractors: [
      'Protocol v0.1 requires deterministic thread matching and sender authenticity checks.',
      'Memory summaries should be cached and invalidated on new writes.',
      'Never push directly to main; branch + PR is required.',
    ],
    provenance: 'memory:c92b5753-c9b2-4393-8b45-593fbcda7134 (wren, decision:studio-routing)',
  },
  {
    id: 'project-thread-prioritization',
    threadKey: 'project:pcp/memory',
    focusText: 'bootstrap memory architecture and knowledge summary budget',
    targetTopicKey: 'project:pcp/memory',
    targetContent:
      'Hierarchical memory phase 1 introduced summary + topicKey and budgeted topic-grouped bootstrap knowledge summaries.',
    distractors: [
      'Tool routing executes MCP calls through authenticated PCP client connections.',
      'Playwright skill sync writes SKILL.md to backend-native directories.',
      'Session lifecycle includes running, idle, completed, and failed.',
    ],
    provenance: 'memory:e770da50-5afc-4b99-b9a1-da012eebfdd2 (wren, project:pcp/memory)',
  },
  {
    id: 'policy-thread-prioritization',
    threadKey: 'decision:skill-tool-unification',
    focusText: 'unify tool authorization pipeline and skill policy behavior',
    targetTopicKey: 'decision:skill-tool-unification',
    targetContent:
      'Skills should be treated as labeled tools under the same allow/deny/prompt policy pipeline.',
    distractors: [
      'Bootstrap can load identity files from ~/.pcp as fallback.',
      'Memory bridge in phase 2 can normalize topic hints asynchronously.',
      'PR thread keys preserve continuity in cross-agent collaboration.',
    ],
    provenance:
      'memory:a6ea834f-1066-4a16-9e6c-aa9cd68e629c (wren, decision:skill-tool-unification)',
  },
];

export function getBootstrapRelevanceDataset(dataset: string): BootstrapRelevanceCase[] {
  if (dataset === 'bootstrap-relevance-v1') return BOOTSTRAP_RELEVANCE_V1;
  throw new Error(
    `Unknown bootstrap relevance dataset "${dataset}". Supported datasets: bootstrap-relevance-v1`
  );
}
