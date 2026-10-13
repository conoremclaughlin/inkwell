/** Compatibility path; all hosts use the same recall and budget hooks. */
export {
  extractTopicSignal,
  registerPassiveRecallHook,
  registerBudgetMonitorHook,
  registerBuiltinHooks,
  type PassiveRecallConfig,
  type PassiveRecallStats,
} from '@inklabs/shared/runtime';
