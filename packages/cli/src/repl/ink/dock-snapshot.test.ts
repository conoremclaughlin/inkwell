import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString, Box, Text } from 'ink';
import { GUTTER_WIDTH, MessageLine, centerGutterMarker } from './MessageLine.js';
import { SlashAutocomplete } from './SlashAutocomplete.js';
import { InfoBar } from './InfoBar.js';

const h = React.createElement;
const COLS = 80;

// Mirrors the real dock layout (ChatApp/Dock): waiting indicator, separator,
// gutter-aligned prompt, autocomplete panel, separator, then ONE consolidated
// InfoBar carrying cwd/branch + context status on the left and the clock on
// the right — there is no dedicated status row above the prompt anymore.
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
        null,
        h(
          Box,
          { width: GUTTER_WIDTH, flexShrink: 0 },
          h(Text, { color: 'cyan' }, centerGutterMarker('✻'))
        ),
        h(Text, { dimColor: true }, `${props.waitingVerb}...`)
      ),
    h(Text, { dimColor: true }, sep),
    h(
      Box,
      { paddingRight: 1 },
      h(
        Box,
        { width: GUTTER_WIDTH, flexShrink: 0 },
        h(Text, { bold: true, color: 'green' }, centerGutterMarker('❯'))
      ),
      h(Text, { wrap: 'wrap' }, props.promptValue || ' ')
    ),
    showAutocomplete ? h(SlashAutocomplete, { input: props.promptValue }) : null,
    h(Text, { dimColor: true }, sep),
    h(InfoBar, { items: [...props.infoItems, props.statusSummary], right: props.time })
  );
}

describe('Dock snapshot rendering', () => {
  it('renders idle dock — status + clock live in the bottom InfoBar', () => {
    const output = renderToString(
      h(DockSnapshot, {
        statusSummary: '1.1k+9.4k/850k (1.2%)  ·  idle  ·  claude',
        time: '6:38 PM',
        promptValue: '',
        infoItems: ['…/pcp/personal-context-protocol', 'main'],
      }),
      { columns: COLS }
    );
    console.log('\n=== IDLE DOCK ===');
    console.log(output);
    expect(output).toContain('❯');
    expect(output).toContain('6:38 PM');
    expect(output).toContain('850k');
    expect(output).toContain('main');
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
        statusSummary: '1.1k/850k (0.1%)',
        time: '6:40 PM',
        promptValue: '',
        infoItems: ['main'],
        waitingVerb: 'Thinking',
      }),
      { columns: COLS }
    );
    console.log('\n=== WAITING DOCK ===');
    console.log(output);
    expect(output).toContain('✻');
    expect(output).toContain('Thinking...');
    // Spinner glyph is centered in the gutter, not hugging column 0
    // eslint-disable-next-line no-control-regex
    const lines = output.replace(/\u001b\[[0-9;]*m/g, '').split('\n');
    expect(lines).toContainEqual(expect.stringMatching(/^ ✻ Thinking/));
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

  it('aligns markers in the gutter and text at the content column', () => {
    const output = renderToString(
      h(
        Box,
        { flexDirection: 'column' },
        h(MessageLine, {
          id: 'g-1',
          role: 'user' as const,
          content: 'hello there',
          label: 'you',
          time: '6:01 PM',
        }),
        h(MessageLine, {
          id: 'g-2',
          role: 'assistant' as const,
          content: 'hi back',
          label: 'myra',
          time: '6:01 PM',
        }),
        h(MessageLine, {
          id: 'g-3',
          role: 'event' as const,
          content: '🛠 myra · send_response (executed)',
        }),
        h(MessageLine, {
          id: 'g-4',
          role: 'inbox' as const,
          content: 'ping from lumen',
          label: '📬 inbox',
          time: '6:02 PM',
        })
      ),
      { columns: COLS }
    );
    console.log('\n=== GUTTER ALIGNMENT ===');
    console.log(output);
    // eslint-disable-next-line no-control-regex
    const lines = output.replace(/\u001b\[[0-9;]*m/g, '').split('\n');
    // Heading rows: single-width markers are CENTERED in the gutter (column
    // 1), label text at the content column (3)
    expect(lines).toContainEqual(expect.stringMatching(/^ ❯ you {2}6:01 PM/));
    expect(lines).toContainEqual(expect.stringMatching(/^ ✦ myra {2}6:01 PM/));
    // Label emoji moves to the gutter; double-width glyphs keep column 0 (a
    // 2-col glyph already fills the 3-col gutter visually)
    expect(lines).toContainEqual(expect.stringMatching(/^📬 inbox {2}6:02 PM/));
    // Body rows sit at the content column, aligned under the heading text
    expect(lines).toContainEqual(expect.stringMatching(/^ {3}hello there/));
    expect(lines).toContainEqual(expect.stringMatching(/^ {3}hi back/));
    // Event marker centered in the gutter (🛠 measures 1), text at column 3
    expect(lines).toContainEqual(expect.stringMatching(/^ 🛠 +myra · send_response/));
  });

  it('renders a blank row between the heading and the body', () => {
    const output = renderToString(
      h(MessageLine, {
        id: 'm-1',
        role: 'assistant' as const,
        content: 'body text',
        label: 'myra',
        time: '6:01 PM',
      }),
      { columns: COLS }
    );
    // eslint-disable-next-line no-control-regex
    const lines = output.replace(/\u001b\[[0-9;]*m/g, '').split('\n');
    const headingIdx = lines.findIndex((l) => l.includes('myra'));
    const bodyIdx = lines.findIndex((l) => l.includes('body text'));
    expect(headingIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBe(headingIdx + 2);
    expect(lines[headingIdx + 1]!.trim()).toBe('');
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
