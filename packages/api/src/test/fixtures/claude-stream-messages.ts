/**
 * Frozen fixtures for Claude Code stream-json output.
 *
 * These represent realistic JSON lines emitted by Claude Code's --output-format stream-json
 * during a session. Used for testing tool call/result parsing and activity stream persistence.
 *
 * Based on real tool interactions (list_emails, get_email) with all PII replaced.
 */

import type { ClaudeStreamMessage } from './types';

/**
 * A system message that opens a Claude Code session.
 */
export const systemSessionStart: ClaudeStreamMessage = {
  type: 'system',
  session_id: 'test-session-abc-123',
};

/**
 * An assistant message containing a text block + a list_emails tool_use call.
 */
export const assistantWithListEmailsToolUse: ClaudeStreamMessage = {
  type: 'assistant',
  message: {
    content: [
      {
        type: 'text',
        text: "I'll check your recent emails now.",
      },
      {
        type: 'tool_use',
        id: 'toolu_01ABC123',
        name: 'mcp__pcp__list_emails',
        input: {
          userId: '00000000-0000-0000-0000-000000000001',
          maxResults: 5,
        },
      },
    ],
  },
};

/**
 * A user message containing the tool_result for list_emails.
 * Based on real Gmail API response with marketing/newsletter emails.
 */
export const userWithListEmailsToolResult: ClaudeStreamMessage = {
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_01ABC123',
        content: JSON.stringify({
          success: true,
          emails: [
            {
              id: 'msg-fixture-001',
              threadId: 'thread-fixture-001',
              subject: 'Re: [example-co/example-app] feat(api): add data sync endpoint (PR #42)',
              from: { name: 'Alex Chen', email: 'notifications@github.com' },
              to: [{ name: 'example-co/example-app', email: 'example-app@noreply.github.com' }],
              date: 'Tue, 03 Feb 2026 23:19:15 -0800',
              snippet:
                '@devuser pushed 1 commit. a1b2c3d feat(api): add data sync endpoint for cross-env data transfer...',
              isUnread: true,
              isStarred: false,
              hasAttachments: false,
            },
            {
              id: 'msg-fixture-002',
              threadId: 'msg-fixture-002',
              subject: '[TechDigest] Context Graphs and Agent Traces',
              from: { name: 'Tech Digest', email: 'digest@newsletter.example.com' },
              to: [{ email: 'user@example.com' }],
              date: 'Wed, 4 Feb 2026 03:13:58 +0000',
              snippet: 'a quiet day lets us feature a bubbling topic.',
              isUnread: true,
              isStarred: false,
              hasAttachments: false,
            },
            {
              id: 'msg-fixture-003',
              threadId: 'msg-fixture-003',
              subject: 'Scholar Alert Digest 04/02',
              from: { name: 'Scholar Inbox', email: 'noreply@scholar.example.com' },
              to: [{ email: 'user@example.com' }],
              date: 'Wed, 4 Feb 2026 06:00:20 +0100',
              snippet:
                'Dear user, a new Scholar Inbox digest has been created. Today, we found 76 articles relevant for you.',
              isUnread: true,
              isStarred: false,
              hasAttachments: false,
            },
          ],
          count: 3,
        }),
      },
    ],
  },
};

/**
 * An assistant message containing a get_email tool_use call.
 */
export const assistantWithGetEmailToolUse: ClaudeStreamMessage = {
  type: 'assistant',
  message: {
    content: [
      {
        type: 'text',
        text: 'Let me look at the GitHub PR notification in detail.',
      },
      {
        type: 'tool_use',
        id: 'toolu_02DEF456',
        name: 'mcp__pcp__get_email',
        input: {
          userId: '00000000-0000-0000-0000-000000000001',
          messageId: 'msg-fixture-001',
        },
      },
    ],
  },
};

/**
 * A user message containing the tool_result for get_email.
 * Based on real GitHub notification email with URLs sanitized.
 */
export const userWithGetEmailToolResult: ClaudeStreamMessage = {
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_02DEF456',
        content: JSON.stringify({
          success: true,
          email: {
            id: 'msg-fixture-001',
            threadId: 'thread-fixture-001',
            labelIds: ['UNREAD', 'CATEGORY_FORUMS', 'INBOX'],
            subject: 'Re: [example-co/example-app] feat(api): add data sync endpoint (PR #42)',
            from: { name: 'Alex Chen', email: 'notifications@github.com' },
            to: [{ name: 'example-co/example-app', email: 'example-app@noreply.github.com' }],
            date: 'Tue, 03 Feb 2026 23:19:15 -0800',
            body: {
              text: '@devuser pushed 1 commit.\r\n\r\na1b2c3d feat(api): add data sync endpoint for cross-env data transfer\r\n\r\nView it on GitHub:\r\nhttps://github.com/example-co/example-app/pull/42',
            },
            isUnread: true,
            isStarred: false,
          },
        }),
      },
    ],
  },
};

/**
 * An assistant message containing a send_response tool_use call.
 */
export const assistantWithSendResponse: ClaudeStreamMessage = {
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_03GHI789',
        name: 'mcp__pcp__send_response',
        input: {
          userId: '00000000-0000-0000-0000-000000000001',
          channel: 'telegram',
          conversationId: '123456789',
          content:
            'You have 3 unread emails. The most notable is a GitHub PR notification — Alex pushed a commit to PR #42 adding a data management command.',
        },
      },
    ],
  },
};

/**
 * A user message containing the tool_result for send_response.
 */
export const userWithSendResponseResult: ClaudeStreamMessage = {
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_03GHI789',
        content: 'Response sent successfully',
      },
    ],
  },
};

/**
 * A result message with token usage stats (typical end of a turn).
 */
export const resultWithUsage: ClaudeStreamMessage = {
  type: 'result',
  result: '',
  usage: {
    input_tokens: 12500,
    output_tokens: 850,
    cache_read_input_tokens: 18000,
    cache_creation_input_tokens: 4500,
  },
};

/**
 * A result message with high token usage that would trigger compaction.
 * context = 125000 + 45000 + 5000 = 175000
 */
export const resultWithHighUsage: ClaudeStreamMessage = {
  type: 'result',
  result: '',
  usage: {
    input_tokens: 125000,
    output_tokens: 3500,
    cache_read_input_tokens: 45000,
    cache_creation_input_tokens: 5000,
  },
};

/**
 * A complete sequence representing a realistic email-checking interaction.
 * Useful for integration-style tests that process multiple lines.
 */
export const emailCheckSequence: ClaudeStreamMessage[] = [
  systemSessionStart,
  assistantWithListEmailsToolUse,
  userWithListEmailsToolResult,
  assistantWithGetEmailToolUse,
  userWithGetEmailToolResult,
  assistantWithSendResponse,
  userWithSendResponseResult,
  resultWithUsage,
];

/**
 * Convert a ClaudeStreamMessage to a JSON line (as emitted by Claude Code stdout).
 */
export function toJsonLine(message: ClaudeStreamMessage): string {
  return JSON.stringify(message);
}

/**
 * Convert a sequence of messages to newline-delimited JSON (Claude Code stdout format).
 */
export function toJsonLines(messages: ClaudeStreamMessage[]): string {
  return messages.map(toJsonLine).join('\n') + '\n';
}
