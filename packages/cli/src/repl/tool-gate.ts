import { ToolPolicyState } from './tool-policy.js';

export interface EnsureInkToolAllowedParams {
  policy: ToolPolicyState;
  tool: string;
  sessionId?: string;
  prompt: (reason: string) => Promise<boolean>;
}

export async function ensureInkToolAllowed(params: EnsureInkToolAllowedParams): Promise<boolean> {
  const { policy, tool, sessionId, prompt } = params;
  const decision = policy.canCallInkTool(tool, sessionId);
  if (decision.allowed) return true;
  if (!decision.promptable) return false;
  return prompt(decision.reason);
}
