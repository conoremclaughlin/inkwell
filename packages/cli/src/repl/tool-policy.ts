/** CLI persistence adapter; policy decisions are shared with non-CLI hosts. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import {
  ToolPolicyState as SessionToolPolicy,
  type ToolMode,
  type ToolPolicyContext,
  type ToolPolicyScopeRef,
  type ToolPolicySnapshot,
  type PersistedToolPolicyV2,
} from '@inklabs/shared/runtime';
export {
  DEFAULT_SAFE_INK_TOOLS,
  TOOL_GROUPS,
  expandPolicySpecs,
  type ToolGroupMap,
  type ToolMode,
  type SkillTrustMode,
  type SessionVisibility,
  type ToolPolicyScopeKind,
  type ToolPolicyScopeRef,
  type ToolPolicyContext,
  type ToolPolicyDecision,
  type SessionAccessQuery,
  type ToolPolicyScopeSnapshot,
  type BackendToolGate,
  type SetMutationScopeResult,
} from '@inklabs/shared/runtime';

export interface ToolPolicyOptions {
  persist?: boolean;
  policyPath?: string;
  context?: ToolPolicyContext;
  mutationScope?: ToolPolicyScopeRef;
}

const DEFAULT_POLICY_PATH = join(homedir(), '.ink', 'security', 'tool-policy.json');

function readPolicy(path: string): ToolPolicySnapshot | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ToolPolicySnapshot;
  } catch {
    // Preserve the existing CLI fallback for unreadable or malformed policy.
    return undefined;
  }
}

function writePolicy(path: string, snapshot: PersistedToolPolicyV2): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(dirname(path), 0o700);
    chmodSync(path, 0o600);
  } catch {
    // Best-effort hardening only, as before.
  }
}

export class ToolPolicyState extends SessionToolPolicy {
  private readonly policyPath: string;

  constructor(initialMode: ToolMode = 'backend', options?: ToolPolicyOptions) {
    const path = options?.policyPath || DEFAULT_POLICY_PATH;
    const persist = options?.persist ?? true;
    super(initialMode, {
      context: options?.context,
      mutationScope: options?.mutationScope,
      ...(persist
        ? { snapshot: readPolicy(path), onChange: (value) => writePolicy(path, value) }
        : {}),
    });
    this.policyPath = path;
  }

  public getPolicyPath(): string {
    return this.policyPath;
  }
}
