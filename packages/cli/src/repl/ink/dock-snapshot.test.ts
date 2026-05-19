import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString, Box, Text } from 'ink';
import { MessageLine } from './MessageLine.js';
import { SlashAutocomplete } from './SlashAutocomplete.js';
import { StatusBar } from './StatusBar.js';
import { InfoBar } from './InfoBar.js';

const h = React.createElement;
const COLS = 80;

function DockSnapshot(props: {
  statusSummary: string;
  time: string;
  promptValue: string;
  infoItems: string[];
  waitingVerb?: string;
}) {
  const sep = '─'.repeat(COLS - 2);
  const showAutocomplete = props.promptValue.startsWith('/');

  return h(
    Box,
    { flexDirection: 'column' },
    props.waitingVerb &&
      h(
        Box,
        { paddingX: 1 },
        h(Text, { color: 'cyan' }, '✦ '),
        h(Text, { dimColor: true }, `${props.waitingVerb}...`)
      ),
    h(Text, { dimColor: true }, sep),
    h(StatusBar, { summary: props.statusSummary, time: props.time }),
    h(Text, { dimColor: true }, sep),
    h(
      Box,
      { paddingX: 1 },
      h(Text, { bold: true, color: 'green' }, '> '),
      h(Text, null, props.promptValue || ' ')
    ),
    showAutocomplete ? h(SlashAutocomplete, { input: props.promptValue }) : null,
    h(Text, { dimColor: true }, sep),
    h(InfoBar, { items: props.infoItems })
  );
}

describe('Dock snapshot rendering', () => {
  it('renders idle dock', () => {
    const output = renderToString(
      h(DockSnapshot, {
        statusSummary:
          '1,079 transcript + 9,400 identity / 1,000,000 (1.0%) queue:idle backend:claude',
        time: '6:38 PM',
        promptValue: '',
        infoItems: [
          '/help',
          'esc cancel',
          'ctrl+c ×2 quit',
          '…/pcp/personal-context-protocol',
          'main',
        ],
      }),
      { columns: COLS }
    );
    console.log('\n=== IDLE DOCK ===');
    console.log(output);
    expect(output).toContain('>');
    expect(output).toContain('6:38 PM');
    expect(output).toContain('/help');
  });

  it('renders dock with slash autocomplete for /mcp', () => {
    const output = renderToString(
      h(DockSnapshot, {
        statusSummary: '1,079 transcript + 9,400 identity / 1,000,000 (1.0%)',
        time: '6:38 PM',
        promptValue: '/mcp',
        infoItems: ['/help', 'esc cancel', 'ctrl+c ×2 quit', 'main'],
      }),
      { columns: COLS }
    );
    console.log('\n=== SLASH AUTOCOMPLETE /mcp ===');
    console.log(output);
    expect(output).toContain('/mcp');
    expect(output).toContain('Manage MCP servers');
    expect(output).toContain('/mcp-servers');
  });

  it('renders dock with slash autocomplete for / showing all commands', () => {
    const output = renderToString(
      h(DockSnapshot, {
        statusSummary: 'idle',
        time: '6:38 PM',
        promptValue: '/',
        infoItems: ['/help', 'main'],
      }),
      { columns: COLS }
    );
    console.log('\n=== SLASH AUTOCOMPLETE / (all commands, max 8) ===');
    console.log(output);
    expect(output).toContain('/help');
    expect(output).toContain('/quit');
    expect(output).toContain('+');
  });

  it('renders dock with slash autocomplete for /b', () => {
    const output = renderToString(
      h(DockSnapshot, {
        statusSummary: 'idle',
        time: '6:38 PM',
        promptValue: '/b',
        infoItems: ['/help', 'main'],
      }),
      { columns: COLS }
    );
    console.log('\n=== SLASH AUTOCOMPLETE /b ===');
    console.log(output);
    expect(output).toContain('/backend');
    expect(output).toContain('/bookmark');
    expect(output).not.toContain('/inbox');
  });

  it('renders waiting dock with thinking indicator', () => {
    const output = renderToString(
      h(DockSnapshot, {
        statusSummary: '1,079 transcript / 1,000,000 (0.1%)',
        time: '6:40 PM',
        promptValue: '',
        infoItems: ['/help', 'esc cancel', 'ctrl+c ×2 quit', 'main'],
        waitingVerb: 'Thinking',
      }),
      { columns: COLS }
    );
    console.log('\n=== WAITING DOCK ===');
    console.log(output);
    expect(output).toContain('✦');
    expect(output).toContain('Thinking...');
  });

  it('shows no autocomplete for non-slash input', () => {
    const output = renderToString(
      h(DockSnapshot, {
        statusSummary: 'idle',
        time: '6:38 PM',
        promptValue: 'hello world',
        infoItems: ['/help', 'main'],
      }),
      { columns: COLS }
    );
    console.log('\n=== NO AUTOCOMPLETE ===');
    console.log(output);
    expect(output).toContain('hello world');
    expect(output).not.toContain('Show available commands');
  });
});

describe('MessageLine rendering', () => {
  it('renders user message', () => {
    const output = renderToString(
      h(MessageLine, {
        id: 'test-1',
        role: 'user' as const,
        content: 'What about with recall? Can you curate and reject?',
        label: 'you',
        time: 'May 13, 6:17 PM',
      }),
      { columns: COLS }
    );
    console.log('\n=== USER MESSAGE ===');
    console.log(output);
    expect(output).toContain('you');
    expect(output).toContain('May 13, 6:17 PM');
    expect(output).toContain('curate and reject');
  });

  it('renders assistant message', () => {
    const output = renderToString(
      h(MessageLine, {
        id: 'test-2',
        role: 'assistant' as const,
        content: 'Ha — perfect timing. You just illustrated the problem.',
        label: 'benson',
        time: 'May 13, 8:25 PM',
      }),
      { columns: COLS }
    );
    console.log('\n=== ASSISTANT MESSAGE ===');
    console.log(output);
    expect(output).toContain('benson');
    expect(output).toContain('May 13, 8:25 PM');
    expect(output).toContain('illustrated the problem');
  });

  it('renders conversation flow with multiple roles', () => {
    const output = renderToString(
      h(
        Box,
        { flexDirection: 'column' },
        h(MessageLine, {
          id: 'msg-1',
          role: 'user' as const,
          content: 'Can you call to Inkwell right now?',
          label: 'you',
          time: '6:01 PM',
        }),
        h(MessageLine, {
          id: 'msg-2',
          role: 'assistant' as const,
          content: 'Yes! Let me check what tools are available.',
          label: 'wren',
          time: '6:01 PM',
        }),
        h(MessageLine, {
          id: 'msg-3',
          role: 'system' as const,
          content: '🛠 recall → 5 memories found',
        }),
        h(MessageLine, {
          id: 'msg-4',
          role: 'assistant' as const,
          content: 'I found 5 relevant memories from your context.',
          label: 'wren',
          time: '6:02 PM',
        })
      ),
      { columns: COLS }
    );
    console.log('\n=== CONVERSATION FLOW ===');
    console.log(output);
    expect(output).toContain('you');
    expect(output).toContain('wren');
    expect(output).toContain('recall');
  });
});
