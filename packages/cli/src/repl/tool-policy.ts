import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export type ToolMode = 'backend' | 'off' | 'privileged';

export interface ToolPolicyDecision {
  allowed: boolean;
  reason: string;
}

export interface ToolPolicyOptions {
  persist?: boolean;
  policyPath?: string;
}

interface PersistedToolPolicy {
  version: 1;
  mode?: ToolMode;
  safeTools?: string[];
  allowTools?: string[];
  denyTools?: string[];
  promptTools?: string[];
  grants?: Record<string, number>;
  readPathAllow?: string[];
  writePathAllow?: string[];
  allowedSkills?: string[];
}

const DEFAULT_POLICY_PATH = join(homedir(), '.pcp', 'security', 'tool-policy.json');

export const DEFAULT_SAFE_PCP_TOOLS = new Set<string>([
  'bootstrap',
  'get_inbox',
  'list_sessions',
  'get_session',
  'get_activity',
  'get_activity_summary',
  'recall',
  'list_artifacts',
  'get_artifact',
  'list_tasks',
  'list_projects',
  'list_reminders',
  'list_workspace_containers',
  'list_workspaces',
  'list_studios',
  'get_workspace_container',
  'get_workspace',
  'get_studio',
  'get_timezone',
  'get_focus',
]);

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

export class ToolPolicyState {
  private mode: ToolMode;
  private persist: boolean;
  private policyPath: string;
  private safeTools = new Set<string>();
  private allowTools = new Set<string>();
  private denyTools = new Set<string>();
  private promptTools = new Set<string>();
  private grants = new Map<string, number>();
  private readPathAllow: string[] = [];
  private writePathAllow: string[] = [];
  private allowedSkills = new Set<string>();

  constructor(initialMode: ToolMode = 'backend', options?: ToolPolicyOptions) {
    this.mode = initialMode;
    this.persist = options?.persist ?? true;
    this.policyPath = options?.policyPath || DEFAULT_POLICY_PATH;

    for (const tool of DEFAULT_SAFE_PCP_TOOLS) {
      this.safeTools.add(tool);
    }
    if (this.persist) {
      this.loadFromDisk();
    }
  }

  private saveToDisk(): void {
    if (!this.persist) return;
    const payload: PersistedToolPolicy = {
      version: 1,
      mode: this.mode,
      safeTools: Array.from(this.safeTools).sort(),
      allowTools: Array.from(this.allowTools).sort(),
      denyTools: Array.from(this.denyTools).sort(),
      promptTools: Array.from(this.promptTools).sort(),
      grants: Object.fromEntries(this.grants.entries()),
      readPathAllow: [...this.readPathAllow],
      writePathAllow: [...this.writePathAllow],
      allowedSkills: Array.from(this.allowedSkills).sort(),
    };

    mkdirSync(dirname(this.policyPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.policyPath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    try {
      chmodSync(dirname(this.policyPath), 0o700);
      chmodSync(this.policyPath, 0o600);
    } catch {
      // Best-effort hardening only.
    }
  }

  private loadFromDisk(): void {
    if (!existsSync(this.policyPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.policyPath, 'utf-8')) as PersistedToolPolicy;
      if (parsed.mode) {
        this.mode = parsed.mode;
      }
      for (const tool of parsed.safeTools || []) this.safeTools.add(normalizeToolName(tool));
      for (const tool of parsed.allowTools || []) this.allowTools.add(normalizeToolName(tool));
      for (const tool of parsed.denyTools || []) this.denyTools.add(normalizeToolName(tool));
      for (const tool of parsed.promptTools || []) this.promptTools.add(normalizeToolName(tool));

      this.grants.clear();
      for (const [tool, uses] of Object.entries(parsed.grants || {})) {
        this.grants.set(normalizeToolName(tool), Math.max(0, Number(uses) || 0));
      }

      this.readPathAllow = [...(parsed.readPathAllow || [])];
      this.writePathAllow = [...(parsed.writePathAllow || [])];
      this.allowedSkills = new Set((parsed.allowedSkills || []).map((skill) => skill.trim()));
    } catch {
      // Ignore malformed policy.
    }
  }

  public getMode(): ToolMode {
    return this.mode;
  }

  public setMode(mode: ToolMode): void {
    this.mode = mode;
    this.saveToDisk();
  }

  public getPolicyPath(): string {
    return this.policyPath;
  }

  public listSafeTools(): string[] {
    return Array.from(this.safeTools).sort();
  }

  public listAllowTools(): string[] {
    return Array.from(this.allowTools).sort();
  }

  public listDenyTools(): string[] {
    return Array.from(this.denyTools).sort();
  }

  public listPromptTools(): string[] {
    return Array.from(this.promptTools).sort();
  }

  public listReadPathAllow(): string[] {
    return [...this.readPathAllow];
  }

  public listWritePathAllow(): string[] {
    return [...this.writePathAllow];
  }

  public listAllowedSkills(): string[] {
    return Array.from(this.allowedSkills).sort();
  }

  public allowTool(tool: string): void {
    const key = normalizeToolName(tool);
    if (!key) return;
    this.allowTools.add(key);
    this.denyTools.delete(key);
    this.saveToDisk();
  }

  public denyTool(tool: string): void {
    const key = normalizeToolName(tool);
    if (!key) return;
    this.denyTools.add(key);
    this.allowTools.delete(key);
    this.saveToDisk();
  }

  public addPromptTool(tool: string): void {
    const key = normalizeToolName(tool);
    if (!key) return;
    this.promptTools.add(key);
    this.saveToDisk();
  }

  public removeToolRule(tool: string): void {
    const key = normalizeToolName(tool);
    if (!key) return;
    this.allowTools.delete(key);
    this.denyTools.delete(key);
    this.promptTools.delete(key);
    this.saveToDisk();
  }

  public setAllowedSkills(skills: string[]): void {
    this.allowedSkills = new Set(skills.map((skill) => skill.trim()).filter(Boolean));
    this.saveToDisk();
  }

  public allowSkill(skill: string): void {
    const next = skill.trim();
    if (!next) return;
    this.allowedSkills.add(next);
    this.saveToDisk();
  }

  public isSkillAllowed(skill: string): boolean {
    if (this.allowedSkills.size === 0) return true;
    return this.allowedSkills.has(skill);
  }

  public canUseBackendTools(): boolean {
    return this.mode !== 'off';
  }

  public grantTool(tool: string, uses = 1): void {
    const key = normalizeToolName(tool);
    const next = Math.max(1, uses);
    this.grants.set(key, (this.grants.get(key) || 0) + next);
    this.saveToDisk();
  }

  public listGrants(): Array<{ tool: string; uses: number }> {
    return Array.from(this.grants.entries())
      .map(([tool, uses]) => ({ tool, uses }))
      .sort((a, b) => a.tool.localeCompare(b.tool));
  }

  public canCallPcpTool(tool: string): ToolPolicyDecision {
    const key = normalizeToolName(tool);
    if (!key) {
      return { allowed: false, reason: 'Invalid tool name.' };
    }

    if (this.mode === 'privileged') {
      return { allowed: true, reason: 'Tool mode is privileged.' };
    }

    if (this.denyTools.has(key)) {
      return { allowed: false, reason: 'Tool is explicitly denied by policy.' };
    }

    if (this.safeTools.has(key)) {
      return { allowed: true, reason: 'Tool is in safe PCP allowlist.' };
    }

    if (this.allowTools.has(key)) {
      return { allowed: true, reason: 'Tool is explicitly allowlisted in policy.' };
    }

    if (this.promptTools.has(key)) {
      return {
        allowed: false,
        reason: 'Tool requires explicit per-call confirmation by policy.',
      };
    }

    const grantUses = this.grants.get(key) || 0;
    if (grantUses > 0) {
      this.grants.set(key, grantUses - 1);
      if (grantUses - 1 <= 0) this.grants.delete(key);
      this.saveToDisk();
      return {
        allowed: true,
        reason: `One-time grant consumed (${grantUses - 1} grant${grantUses - 1 === 1 ? '' : 's'} remaining).`,
      };
    }

    return {
      allowed: false,
      reason:
        'Tool blocked by policy. Use /grant <tool> [uses] for scoped access or /tools privileged for broad access.',
    };
  }
}
