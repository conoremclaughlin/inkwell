import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { handleDescribeTool, type ToolRegistry } from './tool-discovery-handlers';
import { registerAllTools } from './index';

function parse(response: { content: Array<{ text: string }> }): any {
  return JSON.parse(response.content[0].text);
}

function fixtureRegistry(): ToolRegistry {
  return new Map([
    [
      'create_reminder',
      {
        name: 'create_reminder',
        description: 'Create a scheduled reminder. Can be one-time or recurring.\n\nMore detail.',
        inputSchema: z.object({
          title: z.string().describe('Reminder title/message'),
          runAt: z.string().optional().describe('Specific time to run (ISO 8601).'),
        }),
      },
    ],
    [
      'cancel_reminder',
      {
        name: 'cancel_reminder',
        description: 'Cancel a scheduled reminder.',
        // Raw-shape style, as several registrations use.
        inputSchema: { reminderId: z.string().describe('Reminder to cancel') },
      },
    ],
    [
      'save_link',
      { name: 'save_link', description: 'Save a URL.', inputSchema: { url: z.string() } },
    ],
  ]);
}

describe('describe_tool', () => {
  it('returns the parameter schema for a named tool, marking required fields', () => {
    const result = parse(handleDescribeTool({ name: 'create_reminder' }, fixtureRegistry()));

    expect(result.success).toBe(true);
    expect(result.tool.name).toBe('create_reminder');
    expect(result.tool.description).toContain('one-time or recurring');
    // The actual answer to Myra's question: runAt exists, remindAt does not.
    expect(Object.keys(result.tool.parameters.properties)).toEqual(['title', 'runAt']);
    expect(result.tool.parameters.required).toEqual(['title']);
    expect(result.tool.parameters.properties.runAt.description).toContain('ISO 8601');
  });

  it('handles raw-shape registrations as well as ZodObject ones', () => {
    const result = parse(handleDescribeTool({ name: 'cancel_reminder' }, fixtureRegistry()));

    expect(result.success).toBe(true);
    expect(result.tool.parameters.properties.reminderId.description).toBe('Reminder to cancel');
  });

  it('suggests the real tool when the guessed name does not exist', () => {
    // delete_reminder is exactly what Myra guessed; cancel_reminder is real.
    const result = parse(handleDescribeTool({ name: 'delete_reminder' }, fixtureRegistry()));

    expect(result.success).toBe(false);
    expect(result.error).toContain('delete_reminder');
    expect(result.didYouMean).toContain('cancel_reminder');
  });

  it('finds tools by keyword across names and descriptions', () => {
    const result = parse(handleDescribeTool({ search: 'reminder' }, fixtureRegistry()));

    expect(result.count).toBe(2);
    expect(result.tools.map((t: any) => t.name)).toEqual(['cancel_reminder', 'create_reminder']);
    // Summary is the first line only, not the whole description.
    expect(result.tools[1].summary).toBe(
      'Create a scheduled reminder. Can be one-time or recurring.'
    );
  });

  it('reports no matches without pretending to have found something', () => {
    const result = parse(
      handleDescribeTool({ search: 'nonexistent-capability' }, fixtureRegistry())
    );

    expect(result.count).toBe(0);
    expect(result.tools).toEqual([]);
    expect(result.hint).toContain('list every tool name');
  });

  it('lists every tool name when called with no arguments', () => {
    const result = parse(handleDescribeTool({}, fixtureRegistry()));

    expect(result.count).toBe(3);
    expect(result.tools).toEqual(['cancel_reminder', 'create_reminder', 'save_link']);
  });
});

describe('describe_tool against the real registry', () => {
  async function connectedClient() {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const stub: any = new Proxy(function () {} as any, {
      get: () => stub,
      apply: () => stub,
      construct: () => stub,
    });
    registerAllTools(server as any, stub);

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it('answers the question that cost Myra eight failed calls', async () => {
    const client = await connectedClient();

    const response: any = await client.callTool({
      name: 'describe_tool',
      arguments: { name: 'create_reminder' },
    });
    const result = JSON.parse(response.content[0].text);

    expect(result.success).toBe(true);
    const params = result.tool.parameters.properties;
    expect(params).toHaveProperty('runAt');
    expect(params).not.toHaveProperty('remindAt');
    expect(params).not.toHaveProperty('nextRunAt');
    // The worked examples that were already on the server but never reached her.
    expect(result.tool.description).toContain('cron');
  });

  it('describes itself, and covers the whole live registry', async () => {
    const client = await connectedClient();

    const response: any = await client.callTool({ name: 'describe_tool', arguments: {} });
    const result = JSON.parse(response.content[0].text);

    expect(result.tools).toContain('describe_tool');
    expect(result.tools).toContain('respond_to_calendar_event');
    // No `etc.` — the point of generating it is that the list is complete.
    expect(result.count).toBeGreaterThan(150);
  });
});
