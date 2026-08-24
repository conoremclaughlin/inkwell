/**
 * Knowledge summary builder.
 *
 * Groups memories by topic and renders them inside a character budget:
 * critical memories keep up to 1000 chars, high salience 200.
 *
 * Lives here rather than in the MCP tool layer because two callers need it —
 * `bootstrap` and the ContextBuilder that assembles context for spawned
 * sessions. Injecting raw memory rows instead blew a single session's context
 * block past 170KB.
 */

import type { Memory } from '../../data/models/memory';

// ==============================================// KNOWLEDGE SUMMARY BUILDER
// ==============================================
/** Default character budget for the bootstrap knowledge summary. Override with BOOTSTRAP_MEMORY_BUDGET env var. */
const DEFAULT_MEMORY_BUDGET = 8000;

function getMemoryBudget(): number {
  const envBudget = process.env.BOOTSTRAP_MEMORY_BUDGET;
  if (envBudget) {
    const parsed = parseInt(envBudget, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MEMORY_BUDGET;
}

interface TopicGroup {
  topicKey: string;
  memories: Array<{
    id: string;
    displayText: string;
    salience: string;
    createdAt: string;
  }>;
  memoryCount: number;
  lastActivity: string;
  topicSummary?: string; // From metadata.topicSummary on the most recent memory
}

/**
 * Build a budget-constrained knowledge summary from memories grouped by topic.
 * Returns both the formatted summary text and a topic index for overflow.
 */
export function buildKnowledgeSummary(memories: Memory[]): {
  knowledgeSummary: string;
  topicIndex: Array<{
    topicKey: string;
    memoryCount: number;
    lastActivity: string;
    topicSummary?: string;
  }>;
  memoriesIncluded: number;
  memoryIds: string[];
} {
  const budget = getMemoryBudget();

  // Group memories by topicKey (or first topic, or 'uncategorized')
  const groups = new Map<string, TopicGroup>();

  for (const m of memories) {
    const key = m.topicKey || (m.topics.length > 0 ? m.topics[0] : 'uncategorized');
    // Critical memories get full content (core identity, worth the budget).
    // High memories get truncated. Skip summary when it's identical to content.
    const rawText = m.summary && m.summary !== m.content ? m.summary : m.content;
    const displayText =
      m.salience === 'critical' ? truncateContent(rawText, 1000) : truncateContent(rawText, 200);
    const createdAt = m.createdAt.toISOString().slice(0, 10); // YYYY-MM-DD

    if (!groups.has(key)) {
      groups.set(key, {
        topicKey: key,
        memories: [],
        memoryCount: 0,
        lastActivity: createdAt,
        topicSummary: (m.metadata?.topicSummary as string) || undefined,
      });
    }

    const group = groups.get(key)!;
    group.memories.push({
      id: m.id,
      displayText,
      salience: m.salience,
      createdAt,
    });
    group.memoryCount++;
    if (createdAt > group.lastActivity) group.lastActivity = createdAt;
    // Use topicSummary from the most recent memory that has one
    if (!group.topicSummary && m.metadata?.topicSummary) {
      group.topicSummary = m.metadata.topicSummary as string;
    }
  }

  // Sort groups: most recent activity first
  const sortedGroups = Array.from(groups.values()).sort((a, b) =>
    b.lastActivity.localeCompare(a.lastActivity)
  );

  // Build the summary within budget
  let summary = '';
  let charsUsed = 0;
  let memoriesIncluded = 0;
  const includedTopics = new Set<string>();
  const includedMemoryIds: string[] = [];
  const overflowTopics: typeof sortedGroups = [];

  for (const group of sortedGroups) {
    // Format this group
    const header = group.topicSummary
      ? `### ${group.topicKey} — ${truncateContent(group.topicSummary, 120)}\n`
      : `### ${group.topicKey}\n`;

    let groupText = header;
    for (const mem of group.memories) {
      groupText += `- ${mem.displayText} (${mem.salience}, ${mem.createdAt})\n`;
    }
    groupText += '\n';

    if (charsUsed + groupText.length <= budget) {
      summary += groupText;
      charsUsed += groupText.length;
      memoriesIncluded += group.memories.length;
      includedTopics.add(group.topicKey);
      for (const mem of group.memories) includedMemoryIds.push(mem.id);
    } else if (charsUsed + header.length + 50 <= budget) {
      // Try to fit at least the header + first memory
      const firstMem = group.memories[0];
      const partialText =
        header + `- ${firstMem.displayText} (${firstMem.salience}, ${firstMem.createdAt})\n`;
      const suffix =
        group.memories.length > 1
          ? `  ... and ${group.memories.length - 1} more memories\n\n`
          : '\n';
      const totalPartial = partialText + suffix;
      if (charsUsed + totalPartial.length <= budget) {
        summary += totalPartial;
        charsUsed += totalPartial.length;
        memoriesIncluded += 1;
        includedTopics.add(group.topicKey);
        includedMemoryIds.push(firstMem.id);
      } else {
        overflowTopics.push(group);
      }
    } else {
      overflowTopics.push(group);
    }
  }

  // Build topic index from ALL topics (including overflow)
  const topicIndex = sortedGroups.map((g) => ({
    topicKey: g.topicKey,
    memoryCount: g.memoryCount,
    lastActivity: g.lastActivity,
    topicSummary: g.topicSummary,
  }));

  return {
    knowledgeSummary: summary.trim(),
    topicIndex,
    memoriesIncluded,
    memoryIds: includedMemoryIds,
  };
}

function truncateContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen - 3) + '...';
}
