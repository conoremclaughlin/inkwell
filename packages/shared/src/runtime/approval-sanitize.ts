/** Only the existing small path/command preview goes to approval notifications. */
export function sanitizeArgsForApproval(tool: string, args: Record<string, unknown>): string {
  const policyName = tool.replace(/^mcp__inkwell__/, '');
  switch (policyName) {
    case 'bash':
      return typeof args.command === 'string' ? args.command.slice(0, 500) : '';
    case 'write':
    case 'edit': {
      const path = (args.path ?? args.file_path ?? args.filePath) as string | undefined;
      return path ? path.slice(0, 200) : '';
    }
    case 'read':
    case 'ls':
    case 'grep':
    case 'find': {
      const path = (args.path ?? args.file_path ?? args.filePath ?? args.pattern) as
        | string
        | undefined;
      return path ? path.slice(0, 200) : '';
    }
    default:
      return '';
  }
}
