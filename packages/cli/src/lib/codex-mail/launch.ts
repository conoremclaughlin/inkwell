import { resolve } from 'node:path';

/** Split the native invocation without silently dropping configuration. Unknown
 * options are refused in this experimental mode, not guessed or weakened. */
export function splitCodexMailArgs(args: string[], cwd: string) {
  const serverArgs = ['app-server', '--listen', 'stdio://'];
  const tuiArgs: string[] = [];
  const threadOverrides: Record<string, unknown> = {};
  const roots: string[] = [];
  let resumeId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => {
      const next = args[++i];
      if (!next || next.startsWith('-')) throw new Error(`Missing value for ${arg}`);
      return next;
    };
    if (['-c', '--config', '--enable', '--disable'].includes(arg)) {
      serverArgs.push(arg, value());
    } else if (arg.startsWith('--config=')) {
      serverArgs.push(arg);
    } else if (arg === '--strict-config') {
      serverArgs.push(arg);
    } else if (arg === '--search') {
      serverArgs.push('-c', 'web_search="live"');
    } else if (arg === '--add-dir') {
      roots.push(resolve(cwd, value()));
    } else if (arg === '--model' || arg === '-m') {
      threadOverrides.model = value();
    } else if (arg === '--sandbox' || arg === '-s') {
      const sandbox = value();
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) {
        throw new Error('Unsupported Codex sandbox');
      }
      threadOverrides.sandbox = sandbox;
    } else if (arg === '--ask-for-approval' || arg === '-a') {
      const policy = value();
      if (!['never', 'on-request'].includes(policy)) throw new Error('Unsupported approval policy');
      threadOverrides.approvalPolicy = policy;
    } else if (arg === '--dangerously-bypass-approvals-and-sandbox') {
      threadOverrides.sandbox = 'danger-full-access';
      threadOverrides.approvalPolicy = 'never';
    } else if (arg === '--no-alt-screen') {
      tuiArgs.push(arg);
    } else if (arg === 'resume' && !resumeId) {
      resumeId = value();
      if (!/^[0-9a-f-]{36}$/i.test(resumeId))
        throw new Error('Codex Inkmail requires an exact resume UUID');
    } else {
      throw new Error(
        `Codex Inkmail does not yet support ${arg}; omit --codex-inkmail to use the normal launcher`
      );
    }
  }
  if (roots.length) threadOverrides.runtimeWorkspaceRoots = [...new Set([resolve(cwd), ...roots])];
  if (resumeId) tuiArgs.push('resume', resumeId);
  return { serverArgs, tuiArgs, threadOverrides };
}
