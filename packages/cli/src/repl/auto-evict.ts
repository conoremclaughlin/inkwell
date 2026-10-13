// Compatibility path; the host-independent policy lives in the shared runtime.
export {
  AUTO_EVICT_KEEP_RECENT_TURNS,
  AUTO_EVICT_MIN_SHARE,
  AUTO_EVICT_MIN_TOKENS,
  AUTO_EVICT_TOMBSTONE_SOURCE,
  LOCAL_TOOL_RESULT_SOURCE,
  READ_ONLY_TOOLS,
  autoEvictTombstone,
  isSemanticFailure,
  isWriteSideTool,
  localToolLedgerLine,
  selectConsumedToolResults,
  type AutoEvictSelection,
} from '@inklabs/shared/runtime';
