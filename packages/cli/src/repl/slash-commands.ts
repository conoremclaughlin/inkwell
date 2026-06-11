export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'Show available commands' },
  { name: 'quit', description: 'End chat session' },
  { name: 'exit', description: 'End chat session' },
  { name: 'refresh', description: 'Re-bootstrap identity context' },
  { name: 'inbox', description: 'Poll inbox now' },
  { name: 'events', description: 'Poll/toggle activity stream' },
  { name: 'session', description: 'Show active session info' },
  { name: 'sessions', description: 'Show active sessions' },
  { name: 'autorun', description: 'Toggle inbox auto-run' },
  { name: 'away', description: 'Toggle remote approval mode' },
  { name: 'tool-routing', description: 'Switch backend/local tool routing' },
  { name: 'save-config', description: 'Save runtime preferences' },
  { name: 'ui', description: 'Set status rendering mode' },
  { name: 'backend', description: 'Switch backend (claude|codex|gemini)' },
  { name: 'model', description: 'Set/clear model override' },
  { name: 'tools', description: 'Toggle backend-native tools' },
  { name: 'grant', description: 'Grant blocked tool for limited uses' },
  { name: 'grant-session', description: 'Allow tool for this session' },
  { name: 'allow', description: 'Persistently allow tool' },
  { name: 'deny', description: 'Persistently deny tool' },
  { name: 'prompt', description: 'Require per-call approval' },
  { name: 'policy-scope', description: 'Set rule mutation scope' },
  { name: 'policy', description: 'Show tool policy snapshot' },
  { name: 'policy-reset', description: 'Reset policy scope to defaults' },
  { name: 'mcp', description: 'Manage MCP servers' },
  { name: 'mcp-servers', description: 'List MCP servers from .mcp.json' },
  { name: 'capabilities', description: 'Show MCP + skills + policy snapshot' },
  { name: 'ink', description: 'Call Inkwell tool directly' },
  { name: 'thread', description: 'Show/set active thread key' },
  { name: 'skills', description: 'List discovered skills' },
  { name: 'skill-trust', description: 'Set skill trust policy' },
  { name: 'skill-use', description: 'Activate a skill for prompts' },
  { name: 'skill-clear', description: 'Clear active skills' },
  { name: 'session-visibility', description: 'Set session visibility' },
  { name: 'path-allow-read', description: 'Allow local reads for path' },
  { name: 'path-allow-write', description: 'Allow local writes for path' },
  { name: 'profile', description: 'Apply security profile' },
  { name: 'delegate-create', description: 'Mint delegation token' },
  { name: 'delegate-show', description: 'Show delegation token' },
  { name: 'delegate-verify', description: 'Verify delegation token' },
  { name: 'delegate-send', description: 'Send inbox with delegation' },
  { name: 'bookmark', description: 'Set context bookmark' },
  { name: 'bookmarks', description: 'List bookmarks' },
  { name: 'eject', description: 'Eject context to bookmark' },
  { name: 'trim', description: 'Trim oldest context entries' },
  { name: 'evict', description: 'Evict context entries (ids, source:, role:)' },
  { name: 'evicted', description: 'Show evicted-from-context entries' },
  { name: 'context', description: 'Open context inspector (bootstrap, memories, ledger)' },
  { name: 'usage', description: 'Show context token estimate' },
];

export function filterCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  const query = input.slice(1).toLowerCase();
  if (!query) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(query));
}
