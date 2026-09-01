import { describe, expect, it } from 'vitest';
import { parseTranscript } from './transcript';

describe('parseTranscript — claude-code', () => {
  it('turns user/assistant events into turns and merges consecutive assistant chunks', () => {
    const events = [
      { type: 'user', uuid: 'u1', timestamp: 't1', message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: 't2',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Looking…' },
            { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: 't3',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file body' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: 't4',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      },
      { type: 'queue-operation' },
    ];

    const turns = parseTranscript('claude-code', events);

    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns[1].blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool-call']);
    expect(turns[2].blocks[0]).toMatchObject({ kind: 'tool-result', toolUseId: 'tu1' });
    expect(turns[3].blocks[0]).toEqual({ kind: 'text', text: 'Done.' });
  });

  it('keeps hook attachments as system turns and drops empty content', () => {
    const events = [
      {
        type: 'attachment',
        uuid: 's1',
        timestamp: 't1',
        attachment: { type: 'hook_success', hookName: 'SessionStart', content: 'bootstrapped' },
      },
      { type: 'user', uuid: 'u1', timestamp: 't2', message: { role: 'user', content: '   ' } },
      'garbage',
      null,
    ];

    const turns = parseTranscript('claude-code', events);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      role: 'system',
      blocks: [{ kind: 'system', subtype: 'SessionStart', text: 'bootstrapped' }],
    });
  });
});

describe('parseTranscript — ink', () => {
  it('maps activity-stream directions to roles and lifecycle events to system turns', () => {
    const events = [
      { id: '1', type: 'agent_spawn', timestamp: 't0', content: '' },
      { id: '2', type: 'message_in', direction: 'in', content: 'hi myra', timestamp: 't1' },
      { id: '3', type: 'message_out', direction: 'out', content: 'hi conor', timestamp: 't2' },
      { id: '4', type: 'error', content: 'boom', timestamp: 't3' },
    ];

    const turns = parseTranscript('ink', events);

    expect(turns.map((t) => [t.role, t.blocks[0].kind])).toEqual([
      ['system', 'system'],
      ['user', 'text'],
      ['assistant', 'text'],
      ['system', 'system'],
    ]);
    expect(turns[3].blocks[0]).toMatchObject({ text: 'error: boom' });
  });
});

describe('parseTranscript — backend dispatch', () => {
  it('routes by backend name and falls back to the claude parser', () => {
    const codex = [{ type: 'user', id: 'c1', content: 'q' }];
    expect(parseTranscript('codex', codex)[0]).toMatchObject({ role: 'user' });

    const gemini = [{ role: 'model', parts: [{ text: 'answer' }] }];
    expect(parseTranscript('gemini-cli', gemini)[0]).toMatchObject({ role: 'assistant' });

    const claude = [{ type: 'user', message: { content: 'x' } }];
    expect(parseTranscript('something-else', claude)[0]).toMatchObject({ role: 'user' });
  });
});
