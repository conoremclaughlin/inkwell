/**
 * ink observe — unit tests for the SSE parser and the observer-projection
 * renderer (observer-attach M4). The live no-fork e2e lives separately in
 * observe.live.test.ts; these cover the pure pieces.
 */

import { describe, expect, it } from 'vitest';
import { SseParser, renderObserverEntry } from './observe.js';

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

describe('SseParser', () => {
  it('parses id/event/data frames and ignores comment pings', () => {
    const p = new SseParser();
    const frames = p.push(
      `: ping\n\nid: 7\nevent: backend_tool\ndata: {"eid":7,"type":"backend_tool"}\n\n`
    );
    expect(frames).toEqual([
      { id: '7', event: 'backend_tool', data: '{"eid":7,"type":"backend_tool"}' },
    ]);
  });

  it('reassembles a frame split across chunk boundaries', () => {
    const p = new SseParser();
    expect(p.push('id: 3\nevent: backend_te')).toEqual([]);
    const frames = p.push('xt\ndata: {"eid":3}\n\n');
    expect(frames).toEqual([{ id: '3', event: 'backend_text', data: '{"eid":3}' }]);
  });

  it('handles multiple frames in one chunk and multi-line data', () => {
    const p = new SseParser();
    const frames = p.push(
      'event: connected\ndata: {"sessionId":"s1"}\n\ndata: line1\ndata: line2\n\n'
    );
    expect(frames).toHaveLength(2);
    expect(frames[0].event).toBe('connected');
    expect(frames[1].data).toBe('line1\nline2');
  });

  it('normalizes CRLF line endings', () => {
    const p = new SseParser();
    const frames = p.push('id: 1\r\nevent: end\r\ndata: {"reason":"overflow"}\r\n\r\n');
    expect(frames).toEqual([{ id: '1', event: 'end', data: '{"reason":"overflow"}' }]);
  });
});

describe('renderObserverEntry', () => {
  it('renders tool lifecycle entries with eid, name, and status', () => {
    const running = strip(
      renderObserverEntry({ eid: 12, type: 'backend_tool', name: 'WebSearch', status: 'running' })
    );
    expect(running).toContain('#12');
    expect(running).toContain('WebSearch');
    expect(running).toContain('running');

    const done = strip(renderObserverEntry({ eid: 13, type: 'backend_tool', status: 'done' }));
    expect(done).toContain('#13');
    expect(done).toContain('done');
  });

  it('renders text previews dimly truncated', () => {
    const line = strip(
      renderObserverEntry({ eid: 14, type: 'backend_text', preview: 'x'.repeat(500) })
    );
    expect(line).toContain('#14');
    expect(line.length).toBeLessThan(220);
  });

  it('renders conversation turns with role labels', () => {
    expect(strip(renderObserverEntry({ eid: 1, type: 'user', content: 'hi there' }))).toContain(
      'user'
    );
    expect(
      strip(
        renderObserverEntry({ eid: 2, type: 'system_turn', content: 'tick', label: 'heartbeat' })
      )
    ).toContain('system:heartbeat');
    expect(
      strip(renderObserverEntry({ eid: 3, type: 'assistant', content: 'done — 3 emails' }))
    ).toContain('assistant');
  });

  it('falls back safely for unknown projection types', () => {
    const line = strip(renderObserverEntry({ eid: 9, type: 'future_thing', extra: true }));
    expect(line).toContain('#9');
    expect(line).toContain('future_thing');
  });
});
