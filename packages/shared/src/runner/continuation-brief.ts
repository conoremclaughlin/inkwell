/**
 * What a compaction keeps: the continuation brief.
 *
 * One template for both writers of a compaction summary — the ink runtime's
 * own summarizer and an SB writing its brief in its live session — so the two
 * paths cannot drift apart. The sections follow Claude Code's compaction
 * summary (request, concepts, files, errors, problem solving, all user
 * messages, pending tasks, current work, next step) and add what our own
 * compactions lost:
 *
 * - the rules governing the next action, carried verbatim: a summary that
 *   kept state but paraphrased the rules lost them exactly when the next
 *   action needed them (Myra, 2026-10-04);
 * - who is owed an answer and where it routes, conversation id included: a
 *   brief that kept thread keys and session ids but not a Telegram
 *   conversation id cost four tool calls to recover it (Myra, 2026-10-11);
 * - the specific resource, not the bug class: "create_artifact failing"
 *   without naming the artifact cost a whole session (Wren, 2026-04-16).
 */

export interface ContinuationBriefSection {
  title: string;
  guidance: string;
}

export const CONTINUATION_BRIEF_SECTIONS: readonly ContinuationBriefSection[] = [
  {
    title: 'Rules for the next action',
    guidance:
      'Copy verbatim any instruction, constraint or hold that governs what you do next. Do not paraphrase.',
  },
  {
    title: 'Who is owed what',
    guidance:
      'Each person or SB waiting on you: what they asked, and where the answer goes (channel and conversation id, threadKey, sessionKey), with any deadline.',
  },
  {
    title: 'Holds and their wakers',
    guidance:
      'Everything you are waiting on, and what will wake you when it arrives. A wait with nothing to wake it is a dropped obligation.',
  },
  {
    title: 'Current work',
    guidance:
      'Exact identifiers: PR number, branch and head SHA, task id, session id, artifact URI, file:line. Name the specific resource, never only the kind of problem.',
  },
  {
    title: 'Recent messages from people, verbatim',
    guidance: 'Their own words. They are short, and they are the intent.',
  },
  {
    title: 'Decisions',
    guidance: 'Each with a one-line why, and what was ruled out.',
  },
  {
    title: 'Routine and notes',
    guidance:
      'Recurring routines and where durable notes live. Point to notes and memories; do not copy them.',
  },
  {
    title: 'Next step',
    guidance: 'What you do first, quoting the latest instruction it follows from.',
  },
];

export const CONTINUATION_BRIEF_DROP: readonly string[] = [
  'raw tool output: keep a pointer and a one-line result',
  'images: keep the path and what it showed',
  'finished threads: one line with the outcome',
  'anything bootstrap restores (constitution, identity, skills)',
  'anything already saved to memory or notes: a pointer only',
];

/** The template as prompt text, shared by every writer of a brief. */
export function renderContinuationBriefTemplate(): string {
  return [
    'Write these sections, in order, as dense bullet points. Leave a section out only when it is empty.',
    ...CONTINUATION_BRIEF_SECTIONS.map(
      (section, i) => `${i + 1}. ${section.title}: ${section.guidance}`
    ),
    'Mark each fact as measured or inferred, and timestamp state that goes stale.',
    `Drop: ${CONTINUATION_BRIEF_DROP.join('; ')}.`,
  ].join('\n');
}

export interface IdleCompactionPromptInput {
  /** The provider's count of the session's last request. */
  providerContextTokens: number;
  /** The prompt-cache lifetime that request wrote at. */
  cacheTtlSeconds: number;
}

/**
 * The turn the server sends an idle ink session shortly before its prompt
 * cache expires. Written into the live session so the SB reads its history
 * from a warm cache and writes the brief itself: it knows which ids matter,
 * and a summarizer started in a fresh request reads everything cold and sees
 * only the ledger, never the native history the provider holds.
 */
export function buildIdleCompactionPrompt(input: IdleCompactionPromptInput): string {
  const minutes = Math.round(input.cacheTtlSeconds / 60);
  return [
    '[IDLE COMPACTION]',
    `Your context is about ${Math.round(input.providerContextTokens / 1000)}k tokens and has been idle long enough that its ${minutes}-minute prompt cache is about to expire. Compact now, while reading it is still cheap, so your next turn starts small.`,
    '',
    'This turn is only for compacting. Do not start other work, and do not message anyone.',
    '1. Save anything durable that is not yet saved (remember, your notes). The brief is a bridge, not storage.',
    '2. Write your continuation brief:',
    renderContinuationBriefTemplate(),
    '3. Call compact_context with the brief as `summary`. It must be shorter than what it replaces.',
    '4. Reply with one line: what you kept, and its size.',
  ].join('\n');
}
