/**
 * LLM-based query constructor for recall experiments.
 *
 * Spawns `ink --dangerous -b claude -p` to construct natural language
 * recall queries from scenario context. Uses the same auth/backend chain
 * as live tests — no separate API key needed.
 */

import { spawn } from 'child_process';
import type { Scenario } from './types.js';
import type { LlmQueryFn } from './runner.js';

const RESULT_MARKER = 'RECALL_QUERY:';

const SYSTEM_INSTRUCTIONS = `You are an AI agent's memory retrieval subsystem. Given a conversation turn, construct a concise natural language search query to find relevant memories.

Your query should:
- Be 1-3 sentences that capture the core information need
- Include specific terms, names, or concepts that would appear in relevant memories
- Focus on WHAT you need to know, not the conversational context
- Be written as if searching a personal knowledge base

Output the marker "${RESULT_MARKER}" followed by ONLY the query text on one line. No explanation, no formatting, no code fences.`;

function buildPrompt(scenario: Scenario): string {
  const parts: string[] = [SYSTEM_INSTRUCTIONS, ''];
  if (scenario.stalePremise) {
    parts.push(`Previous belief/context: ${scenario.stalePremise}`);
  }
  parts.push(`Current conversation: ${scenario.context}`);
  parts.push(`What I need to know: ${scenario.impliedQuestion}`);
  parts.push('', `Output "${RESULT_MARKER}" followed by your query on one line.`);
  return parts.join('\n');
}

async function spawnInkQuery(prompt: string, timeoutMs: number): Promise<string> {
  const inkBin = process.env.INK_LIVE_BACKEND_CLI ?? 'ink';
  const args = ['--dangerous', '-b', 'claude', '-p', prompt];

  const child = spawn(inkBin, args, {
    cwd: process.env.HOME,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ink query timed out after ${timeoutMs}ms. stderr: ${stderr.slice(-200)}`));
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`ink exited ${exitCode}. stderr: ${stderr.slice(-300)}`);
  }

  const markerLine = stdout
    .split(/\r?\n/)
    .find((line) => line.trimStart().startsWith(RESULT_MARKER));
  if (!markerLine) {
    throw new Error(`Query marker not found in output. Last 300 chars: ${stdout.slice(-300)}`);
  }

  const query = markerLine.trimStart().slice(RESULT_MARKER.length).trim();
  if (!query) throw new Error('LLM returned empty query after marker');
  return query;
}

export function createLlmQueryFn(opts?: { timeoutMs?: number }): LlmQueryFn {
  const timeoutMs = opts?.timeoutMs ?? 60_000;

  return async (scenario: Scenario): Promise<string> => {
    return spawnInkQuery(buildPrompt(scenario), timeoutMs);
  };
}
