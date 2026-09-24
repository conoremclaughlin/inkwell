/**
 * The agent sink's outgoing arguments must agree with the tool that receives
 * them.
 *
 * On 2026-09-15 this branch was brought up to date with main. The merge was
 * clean and left this path broken. main had renamed send_to_inbox's sender
 * field from senderAgentId to senderSlug (#635); the dispatcher still passed
 * senderAgentId. Nothing caught it: handleSendToInbox takes `args: unknown`
 * and parses with a non-strict zod object, so the unknown key was stripped and
 * the alert's sender silently became "unknown" instead of "system". No
 * conflict, no type error, no failing test — the two sides simply stopped
 * agreeing, quietly.
 *
 * So this does not assert what the field is called, which is the belief that
 * was wrong in the first place. It takes the arguments the dispatcher really
 * sends, runs them through the real schema the handler really uses, and checks
 * the sender survives the trip. Renaming either side fails here.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DataComposer } from '../../data/composer';

const { sendToInbox } = vi.hoisted(() => ({
  sendToInbox: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] }),
}));

// The dispatcher reaches the handler through a dynamic import of this
// specifier, so the mock has to carry the same one.
vi.mock('../../mcp/tools/inbox-handlers.js', () => ({ handleSendToInbox: sendToInbox }));

type NotifyAgents = (
  userId: string,
  event: Record<string, unknown>
) => Promise<Array<Record<string, unknown>>>;

describe('the agent sink agrees with send_to_inbox', () => {
  it('sends a sender the receiving schema actually keeps', async () => {
    const { AlertDispatchService } = await import('./alert-dispatch.service');
    const supabase = {} as SupabaseClient;
    const composer = { getClient: () => supabase } as unknown as DataComposer;
    const service = new AlertDispatchService(composer, supabase);

    const notifyAgents = (service as unknown as { notifyAgents: NotifyAgents }).notifyAgents.bind(
      service
    );
    await notifyAgents('3f2504e0-4f89-41d3-9a0c-0305e82c3301', {
      severity: 'critical',
      source: 'disk-monitor',
      title: 'disk is full',
      occurrenceCount: 1,
      notifyAgents: ['myra'],
      kind: 'raised',
    });

    expect(sendToInbox).toHaveBeenCalledTimes(1);
    const args = sendToInbox.mock.calls[0][0] as Record<string, unknown>;

    // The real schema, imported past the mock — not a restatement of it here,
    // which would only pin what this file believes.
    const actual = await vi.importActual<typeof import('../../mcp/tools/inbox-handlers')>(
      '../../mcp/tools/inbox-handlers.js'
    );
    const definition = actual.inboxToolDefinitions.find((t) => t.name === 'send_to_inbox');
    expect(definition, 'send_to_inbox is no longer a registered inbox tool').toBeDefined();

    const parsed = definition!.schema.parse(args) as { senderSlug?: string };

    // The assertion that matters: not that we passed a sender, but that one
    // came out the far side. A stripped key reads as undefined here.
    expect(parsed.senderSlug).toBe('system');
  });
});
