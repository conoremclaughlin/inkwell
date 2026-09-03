import { describe, it, expect } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import {
  autoEvictTombstone,
  isWriteSideTool,
  selectConsumedToolResults,
  LOCAL_TOOL_RESULT_SOURCE,
} from './auto-evict.js';

/** A turn: a user line, some tool results, an assistant reply. */
function turn(ledger: ContextLedger, n: number, results: number, resultChars = 2_000) {
  ledger.addEntry('user', `question ${n}`, 'repl');
  for (let i = 0; i < results; i++) {
    ledger.addEntry(
      'system',
      `local tool list_emails -> ${'{"ok":true,"data":"' + 'x'.repeat(resultChars) + '"}'}`,
      LOCAL_TOOL_RESULT_SOURCE
    );
  }
  ledger.addEntry('assistant', `answer ${n}`, 'claude');
}

describe('selectConsumedToolResults', () => {
  it('clears results older than the protected turns once they outgrow the threshold', () => {
    const ledger = new ContextLedger();
    for (let n = 0; n < 5; n++) turn(ledger, n, 3);
    const pick = selectConsumedToolResults(ledger.listEntries(), {
      keepRecentTurns: 2,
      minTokens: 100,
    });
    expect(pick).not.toBeNull();
    // Turns 0, 1, 2 are older than the last two completed turns: 9 results.
    expect(pick!.ids).toHaveLength(9);
    expect(pick!.tools).toEqual(['list_emails']);
    const kept = ledger.listEntries().filter((e) => !pick!.ids.includes(e.id));
    // Nothing from the two most recent turns is touched.
    expect(kept.filter((e) => e.source === LOCAL_TOOL_RESULT_SOURCE)).toHaveLength(6);
    expect(kept.map((e) => e.content)).toContain('question 0');
  });

  it('never touches the current turn or the protected recent ones, and skips small sweeps', () => {
    const ledger = new ContextLedger();
    turn(ledger, 0, 2);
    turn(ledger, 1, 2);
    // Current turn in progress: results recorded, no assistant entry yet.
    ledger.addEntry('user', 'question 2', 'repl');
    ledger.addEntry('system', 'local tool get_email -> {"big":true}', LOCAL_TOOL_RESULT_SOURCE);
    expect(
      selectConsumedToolResults(ledger.listEntries(), { keepRecentTurns: 2, minTokens: 1 })
    ).toBeNull();
    // Below the threshold: nothing, however old.
    for (let n = 3; n < 6; n++) turn(ledger, n, 1, 10);
    expect(
      selectConsumedToolResults(ledger.listEntries(), { keepRecentTurns: 2, minTokens: 100_000 })
    ).toBeNull();
  });

  it('only counts local-tool entries — messages and replies of any age stay', () => {
    const ledger = new ContextLedger();
    for (let n = 0; n < 4; n++) {
      ledger.addEntry('inbox', 'x'.repeat(4_000), 'inkmail');
      turn(ledger, n, 0);
    }
    expect(
      selectConsumedToolResults(ledger.listEntries(), { keepRecentTurns: 1, minTokens: 1 })
    ).toBeNull();
  });

  it('names refused and failed outcomes by their tool too', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'Local tool blocked (bash): policy', LOCAL_TOOL_RESULT_SOURCE);
    ledger.addEntry(
      'system',
      'Local tool error (send_email): boom ' + 'y'.repeat(3_000),
      LOCAL_TOOL_RESULT_SOURCE
    );
    turn(ledger, 0, 0);
    turn(ledger, 1, 0);
    const pick = selectConsumedToolResults(ledger.listEntries(), {
      keepRecentTurns: 1,
      minTokens: 1,
    });
    expect(pick!.tools).toEqual(['bash', 'send_email']);
    expect(autoEvictTombstone(pick!, 2)).toContain('bash, send_email');
    expect(autoEvictTombstone(pick!, 2)).toContain('transcript holds every one');
  });
});

describe('the tombstone never invites a repeated write (Lumen, PR #584)', () => {
  it.each([
    'send_response',
    'remember',
    'update_memory',
    'create_task',
    'send_email',
    'write',
    'bash',
    'evict_context',
  ])('%s is write-side', (tool) => {
    expect(isWriteSideTool(tool)).toBe(true);
  });
  it.each([
    'list_emails',
    'get_email',
    'recall',
    'search_links',
    'read',
    'grep',
    'list_context',
    'get_session',
    'bootstrap',
  ])('%s is read-side', (tool) => {
    expect(isWriteSideTool(tool)).toBe(false);
  });

  it('says writes already happened and must not be repeated; reads may be re-run', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'local tool send_response -> {"ok":true}', LOCAL_TOOL_RESULT_SOURCE);
    ledger.addEntry(
      'system',
      'local tool list_emails -> {"count":2}' + 'x'.repeat(2_000),
      LOCAL_TOOL_RESULT_SOURCE
    );
    turn(ledger, 0, 0);
    turn(ledger, 1, 0);
    const pick = selectConsumedToolResults(ledger.listEntries(), {
      keepRecentTurns: 1,
      minTokens: 1,
    });
    expect(pick!.writes).toEqual(['send_response']);
    const note = autoEvictTombstone(pick!, 2);
    expect(note).toContain('send_response');
    expect(note).toContain('ALREADY HAPPENED');
    expect(note).toContain('do not repeat');
    expect(note).toContain('list_emails');
    expect(note).not.toMatch(/re-run (a tool|one)[^.]*send_response/);
  });
});
