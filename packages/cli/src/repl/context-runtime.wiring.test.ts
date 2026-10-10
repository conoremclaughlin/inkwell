import { describe, expect, it, vi } from 'vitest';
import * as runtime from '@inklabs/shared/runtime';
import * as ledger from './context-ledger.js';
import * as builtins from './builtin-hooks.js';
import { SbHookRegistry } from './hook-registry.js';

describe('CLI context runtime compatibility paths', () => {
  it('uses the shared implementations, not copies', () => {
    expect(ledger.ContextLedger).toBe(runtime.ContextLedger);
    expect(ledger.entryRefHash).toBe(runtime.entryRefHash);
    expect(builtins.registerBuiltinHooks).toBe(runtime.registerBuiltinHooks);
    expect(new SbHookRegistry()).toBeInstanceOf(runtime.SbHookRegistry);
  });

  it('preserves CLI warning output while hook execution stays in the runtime', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const registry = new SbHookRegistry();
      const error = new Error('fixture hook failure');
      registry.register({
        name: 'fixture',
        event: 'turn_end',
        handler: async () => {
          throw error;
        },
      });
      const result = await registry.fire('turn_end', {
        ledger: new ledger.ContextLedger(),
        runtime: { turnCount: 0 },
      });
      expect(result.blocked).toBe(false);
      expect(warn).toHaveBeenCalledWith('[sb-hook] "fixture" failed on turn_end:', error);
    } finally {
      warn.mockRestore();
    }
  });
});
