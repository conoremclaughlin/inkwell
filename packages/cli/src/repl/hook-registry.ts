import { SbHookRegistry as RuntimeHookRegistry } from '@inklabs/shared/runtime';

export type {
  SbHookEvent,
  HookContext,
  HookRuntimeState,
  InjectedLedgerEntry,
  HookResult,
  SbHook,
  HookErrorReporter,
} from '@inklabs/shared/runtime';

/** Keep CLI diagnostics at the CLI boundary; no console I/O in the engine. */
export class SbHookRegistry extends RuntimeHookRegistry {
  constructor() {
    super((hook, event, error) => {
      // eslint-disable-next-line no-console
      console.warn(`[sb-hook] "${hook}" failed on ${event}:`, error);
    });
  }
}
