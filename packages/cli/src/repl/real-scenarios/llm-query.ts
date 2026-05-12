/**
 * LLM-based query constructor for recall experiments.
 *
 * Given a scenario's conversation context, asks an LLM to construct the
 * natural language query it would use to search a memory system — as
 * opposed to the keyword bag-of-words approach in extractTopicSignal.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Scenario } from './types.js';
import type { LlmQueryFn } from './runner.js';

const SYSTEM_PROMPT = `You are an AI agent's memory retrieval subsystem. Given a conversation turn (what the user said, what you're about to respond to, and your internal question), construct a concise natural language search query to find relevant memories.

Your query should:
- Be 1-3 sentences that capture the core information need
- Include specific terms, names, or concepts that would appear in relevant memories
- Focus on WHAT you need to know, not the conversational context
- Be written as if searching a personal knowledge base

Respond with ONLY the query text, no explanation or formatting.`;

function buildUserPrompt(scenario: Scenario): string {
  const parts: string[] = [];
  if (scenario.stalePremise) {
    parts.push(`Previous belief/context: ${scenario.stalePremise}`);
  }
  parts.push(`Current conversation: ${scenario.context}`);
  parts.push(`What I need to know: ${scenario.impliedQuestion}`);
  return parts.join('\n\n');
}

export function createLlmQueryFn(opts?: { model?: string }): LlmQueryFn {
  const client = new Anthropic();
  const model = opts?.model ?? 'claude-haiku-4-5-20251001';

  return async (scenario: Scenario): Promise<string> => {
    const response = await client.messages.create({
      model,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(scenario) }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!text) throw new Error('LLM returned empty query');
    return text;
  };
}
