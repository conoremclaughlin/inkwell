/** Captured Codex 0.159.2 shapes, with synthetic IDs/paths/text substituted.
 * Only UserPromptSubmit is registered by Inkwell. SubagentStart/SubagentStop
 * are defensive replay fixtures, NOT observed child SessionStart/Stop. */
const common = {
  session_id: 'parent-thread',
  turn_id: 'child-turn',
  agent_id: 'child-thread',
  agent_type: 'default',
  transcript_path: '/fixture/codex/child.jsonl',
  cwd: '/fixture/work',
  model: 'fixture-model',
  permission_mode: 'bypassPermissions',
};
export const capturedSubagentHooks = {
  'on-session-start': { ...common, hook_event_name: 'SubagentStart' },
  'on-prompt': {
    ...common,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'SYNTHETIC_SUBAGENT_CHILD: synthetic lifecycle fixture only; no tools.',
  },
  'on-stop': {
    ...common,
    hook_event_name: 'SubagentStop',
    transcript_path: '/fixture/codex/parent.jsonl',
    agent_transcript_path: '/fixture/codex/child.jsonl',
    stop_hook_active: false,
    last_assistant_message: 'SYNTHETIC_RESPONSE',
  },
} as const;
