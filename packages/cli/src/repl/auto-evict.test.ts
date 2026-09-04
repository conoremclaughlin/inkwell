import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { describe, it, expect } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import {
  autoEvictTombstone,
  isSemanticFailure,
  isWriteSideTool,
  localToolLedgerLine,
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

  it('names refused and failed outcomes by their tool too — each under its own class', () => {
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
    expect(pick!.refused).toEqual(['bash']);
    expect(pick!.failed).toEqual(['send_email']);
    expect(pick!.receipts).toEqual([]);
    const note = autoEvictTombstone(pick!, 2);
    expect(note).toContain('REFUSED (bash)');
    expect(note).toContain('ERRORED (send_email)');
  });
});

describe('the tombstone never claims a write happened when it did not, and never invites a repeat of one that did (Lumen, PR #584 rounds 2–3)', () => {
  it.each([
    'send_response',
    'remember',
    'update_memory',
    'create_task',
    'send_email',
    'edit',
    'write',
    'bash',
    'evict_context',
    'compact_context',
    'signal_status',
    'spawn_agent',
    // Look like reads by name, are not (Lumen, round 3).
    'get_thread_messages',
    'download_email_attachment',
    'download_drive_file',
    // Unknown names default to write.
    'resolve_thing',
    'foo_status',
    'mcp__inkwell__send_response',
  ])('%s is write-side', (tool) => {
    expect(isWriteSideTool(tool)).toBe(true);
  });
  it.each([
    'list_emails',
    'get_email',
    'recall',
    'search_links',
    'list_context',
    'get_session',
    'bootstrap',
    'mcp__inkwell__list_emails',
    // Pi's in-process coding reads (Lumen, round 4).
    'read',
    'grep',
    'find',
    'ls',
  ])('%s is read-side', (tool) => {
    expect(isWriteSideTool(tool)).toBe(false);
  });

  const sweep = () => {
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'local tool send_response -> {"ok":true}', LOCAL_TOOL_RESULT_SOURCE);
    ledger.addEntry(
      'system',
      'Local tool denied (send_email): not allowed',
      LOCAL_TOOL_RESULT_SOURCE
    );
    ledger.addEntry('system', 'Local tool error (remember): timeout', LOCAL_TOOL_RESULT_SOURCE);
    ledger.addEntry(
      'system',
      'local tool list_emails -> {"count":2}' + 'x'.repeat(2_000),
      LOCAL_TOOL_RESULT_SOURCE
    );
    turn(ledger, 0, 0);
    turn(ledger, 1, 0);
    return selectConsumedToolResults(ledger.listEntries(), { keepRecentTurns: 1, minTokens: 1 })!;
  };

  it('keeps the outcome classes apart', () => {
    const pick = sweep();
    expect(pick.receipts).toEqual(['send_response']);
    expect(pick.refused).toEqual(['send_email']);
    expect(pick.failed).toEqual(['remember']);
    expect(pick.reads).toEqual(['list_emails']);
    expect(pick.tools).toEqual(['send_response', 'send_email', 'remember', 'list_emails']);
  });

  it('says what ran stands (read back, do not re-issue); what was refused did not happen; what errored is unknown', () => {
    const note = autoEvictTombstone(sweep(), 2);
    expect(note).toMatch(
      /write calls that RAN \(send_response\) — their effects stand; do not repeat them/
    );
    expect(note).toContain(
      'read the current state back with a read tool instead of re-issuing the write'
    );
    expect(note).toMatch(/REFUSED \(send_email\) — they did not happen/);
    expect(note).toMatch(/ERRORED \(remember\) — whether the effect committed is unknown/);
    expect(note).toMatch(/read calls \(list_emails\) — re-run one only if you need its data again/);
    // Never: a refused or errored call declared done.
    expect(note).not.toMatch(/send_email[^;]*(stand|do not repeat)/);
    expect(note).not.toMatch(/remember[^;]*(stand|do not repeat)/);
    expect(note).not.toContain('ALREADY HAPPENED');
  });
});

describe('a resolved failure is never a receipt (Lumen, PR #584 round 4)', () => {
  it.each([
    [{ success: false, error: 'Myra send failed' }, true],
    [{ isError: true, content: [] }, true],
    [{ success: true }, false],
    [{ ok: true, id: 'x' }, false],
    ['plain text', false],
    [undefined, false],
  ])('isSemanticFailure(%j) → %s', (payload, expected) => {
    expect(isSemanticFailure(payload)).toBe(expected);
  });

  it('records the failure AS a failure at the ledger boundary', () => {
    expect(
      localToolLedgerLine(
        'send_response',
        { success: false, error: 'x' },
        '{"success":false,"error":"x"}'
      )
    ).toBe('Local tool failed (send_response): {"success":false,"error":"x"}');
    expect(localToolLedgerLine('send_response', { success: true }, '{"success":true}')).toBe(
      'local tool send_response -> {"success":true}'
    );
  });

  it("classifies Lumen's exact production shape as failed — even in the legacy executed line", () => {
    const ledger = new ContextLedger();
    ledger.addEntry(
      'system',
      'local tool send_response -> {"success":false,"error":"Myra send failed"}',
      LOCAL_TOOL_RESULT_SOURCE
    );
    ledger.addEntry(
      'system',
      'Local tool failed (send_email): {"isError":true}',
      LOCAL_TOOL_RESULT_SOURCE
    );
    ledger.addEntry(
      'system',
      'local tool remember -> {"success":true,"id":"m1"}' + 'x'.repeat(2_000),
      LOCAL_TOOL_RESULT_SOURCE
    );
    turn(ledger, 0, 0);
    turn(ledger, 1, 0);
    const pick = selectConsumedToolResults(ledger.listEntries(), {
      keepRecentTurns: 1,
      minTokens: 1,
    })!;
    expect(pick.failed).toEqual(['send_response', 'send_email']);
    expect(pick.receipts).toEqual(['remember']);
    const note = autoEvictTombstone(pick, 2);
    expect(note).not.toMatch(/send_response[^;]*(stand|do not repeat)/);
    expect(note).toMatch(/ERRORED \(send_response, send_email\)/);
  });

  it('the recorder in chat.ts goes through localToolLedgerLine', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'chat.ts'),
      'utf8'
    );
    expect(source).toContain('localToolLedgerLine(result.tool, result.result, resultJson)');
    expect(source).not.toContain('`local tool ${result.tool} -> ${resultJson}`');
  });
});
