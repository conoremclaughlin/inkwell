import { ToolPolicyState } from './tool-policy.js';

export interface EnsurePcpToolAllowedParams {
  policy: ToolPolicyState;
  tool: string;
  sessionId?: string;
  prompt: (reason: string) => Promise<boolean>;
}

export async function ensurePcpToolAllowed(params: EnsurePcpToolAllowedParams): Promise<boolean> {
  const { policy, tool, sessionId, prompt } = params;
  const decision = policy.canCallPcpTool(tool, sessionId);
  if (decision.allowed) return true;
  if (!decision.promptable) return false;
  return prompt(decision.reason);
}
