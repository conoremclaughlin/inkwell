import { ToolPolicyState } from './tool-policy.js';

export type ToolApprovalChoice = 'once' | 'session' | 'always' | 'deny' | 'cancel';

export function parseToolApprovalInput(input: string): ToolApprovalChoice {
  const value = input.trim().toLowerCase();
  if (value === 'y' || value === 'yes') return 'once';
  if (value === 's' || value === 'session') return 'session';
  if (value === 'a' || value === 'always') return 'always';
  if (value === 'd' || value === 'deny') return 'deny';
  return 'cancel';
}

export function applyToolApprovalChoice(params: {
  policy: ToolPolicyState;
  tool: string;
  sessionId?: string;
  choice: ToolApprovalChoice;
}): { approved: boolean; message: string } {
  const { policy, tool, sessionId, choice } = params;

  switch (choice) {
    case 'once':
      policy.grantTool(tool, 1);
      return { approved: true, message: 'Granted once.' };
    case 'session':
      if (!sessionId) {
        policy.grantTool(tool, 1);
        return { approved: true, message: 'No session id available; granted once instead.' };
      }
      policy.grantToolForSession(sessionId, tool);
      return { approved: true, message: 'Granted for current session.' };
    case 'always':
      policy.allowTool(tool);
      return { approved: true, message: 'Persistently allowed.' };
    case 'deny':
      policy.denyTool(tool);
      return { approved: false, message: 'Persistently denied.' };
    case 'cancel':
    default:
      return { approved: false, message: 'Cancelled.' };
  }
}
