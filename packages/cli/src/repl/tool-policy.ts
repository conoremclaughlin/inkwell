import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import {
  expandPolicySpecs,
  matchesAnyPolicyPattern,
  normalizePolicyToken,
  type ToolGroupMap,
} from '@personal-context/shared';

export type ToolMode = 'backend' | 'off' | 'privileged';
export type SkillTrustMode = 'all' | 'trusted-only';

export interface ToolPolicyDecision {
  allowed: boolean;
  reason: string;
  promptable?: boolean;
}

export interface ToolPolicyOptions {
  persist?: boolean;
  policyPath?: string;
}

interface PersistedToolPolicy {
  version: 1;
  mode?: ToolMode;
  skillTrustMode?: SkillTrustMode;
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

const TOOL_GROUPS: ToolGroupMap = {
  'group:pcp-safe': Array.from(DEFAULT_SAFE_PCP_TOOLS),
  'group:pcp-comms': ['send_to_inbox', 'trigger_agent', 'send_response'],
  'group:pcp-memory': ['remember', 'recall', 'forget', 'update_memory', 'restore_memory'],
  'group:pcp-session': ['start_session', 'update_session_phase', 'get_session', 'list_sessions', 'end_session'],
};

function normalizeToolName(name: string): string {
  return normalizePolicyToken(name);
}

function expandToolSpec(spec: string): string[] {
  return expandPolicySpecs([spec], TOOL_GROUPS);
}

function addToolSpec(target: Set<string>, spec: string): void {
  const normalized = normalizeToolName(spec);
  if (!normalized) return;
  if (normalized.includes('*')) {
    target.add(normalized);
    return;
  }
  const expanded = expandToolSpec(normalized);
  for (const value of expanded) {
    target.add(value);
  }
}

export class ToolPolicyState {
  private mode: ToolMode;
  private skillTrustMode: SkillTrustMode = 'all';
  private persist: boolean;
  private policyPath: string;
  private safeTools = new Set<string>();
  private allowTools = new Set<string>();
  private denyTools = new Set<string>();
  private promptTools = new Set<string>();
  private grants = new Map<string, number>();
  private sessionGrants = new Map<string, Map<string, number>>();
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
      skillTrustMode: this.skillTrustMode,
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
      if (parsed.skillTrustMode === 'all' || parsed.skillTrustMode === 'trusted-only') {
        this.skillTrustMode = parsed.skillTrustMode;
      }
      for (const tool of parsed.safeTools || []) addToolSpec(this.safeTools, tool);
      for (const tool of parsed.allowTools || []) addToolSpec(this.allowTools, tool);
      for (const tool of parsed.denyTools || []) addToolSpec(this.denyTools, tool);
      for (const tool of parsed.promptTools || []) addToolSpec(this.promptTools, tool);

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

  public getSkillTrustMode(): SkillTrustMode {
    return this.skillTrustMode;
  }

  public setSkillTrustMode(mode: SkillTrustMode): void {
    this.skillTrustMode = mode;
    this.saveToDisk();
  }

  public isSkillTrustAllowed(level: 'trusted' | 'local' | 'untrusted'): boolean {
    if (this.skillTrustMode === 'all') return true;
    return level === 'trusted';
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
    const expanded = expandToolSpec(tool);
    if (expanded.length === 0) return;
    for (const key of expanded) {
      this.allowTools.add(key);
      this.denyTools.delete(key);
      this.promptTools.delete(key);
    }
    this.saveToDisk();
  }

  public denyTool(tool: string): void {
    const expanded = expandToolSpec(tool);
    if (expanded.length === 0) return;
    for (const key of expanded) {
      this.denyTools.add(key);
      this.allowTools.delete(key);
      this.promptTools.delete(key);
    }
    this.saveToDisk();
  }

  public addPromptTool(tool: string): void {
    const expanded = expandToolSpec(tool);
    if (expanded.length === 0) return;
    for (const key of expanded) {
      this.promptTools.add(key);
      this.allowTools.delete(key);
      this.denyTools.delete(key);
    }
    this.saveToDisk();
  }

  public removeToolRule(tool: string): void {
    const expanded = expandToolSpec(tool);
    if (expanded.length === 0) return;
    for (const key of expanded) {
      this.allowTools.delete(key);
      this.denyTools.delete(key);
      this.promptTools.delete(key);
    }
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
    return matchesAnyPolicyPattern(skill, this.allowedSkills);
  }

  public canUseBackendTools(): boolean {
    return this.mode !== 'off';
  }

  public addReadPathAllow(pattern: string): void {
    const normalized = pattern.trim();
    if (!normalized) return;
    this.readPathAllow = Array.from(new Set([...this.readPathAllow, normalized]));
    this.saveToDisk();
  }

  public addWritePathAllow(pattern: string): void {
    const normalized = pattern.trim();
    if (!normalized) return;
    this.writePathAllow = Array.from(new Set([...this.writePathAllow, normalized]));
    this.saveToDisk();
  }

  public isReadPathAllowed(path: string): boolean {
    if (this.readPathAllow.length === 0) return true;
    return matchesAnyPolicyPattern(path, this.readPathAllow);
  }

  public isWritePathAllowed(path: string): boolean {
    if (this.writePathAllow.length === 0) return true;
    return matchesAnyPolicyPattern(path, this.writePathAllow);
  }

  public grantTool(tool: string, uses = 1): void {
    const key = normalizeToolName(tool);
    const next = Math.max(1, uses);
    this.grants.set(key, (this.grants.get(key) || 0) + next);
    this.saveToDisk();
  }

  public grantToolForSession(sessionId: string, tool: string): void {
    const sid = sessionId.trim();
    const key = normalizeToolName(tool);
    if (!sid || !key) return;
    const grants = this.sessionGrants.get(sid) || new Map<string, number>();
    grants.set(key, Number.POSITIVE_INFINITY);
    this.sessionGrants.set(sid, grants);
  }

  public listSessionGrants(sessionId?: string): Array<{ tool: string; uses: number | 'session' }> {
    if (!sessionId) return [];
    const sid = sessionId.trim();
    if (!sid) return [];
    const grants = this.sessionGrants.get(sid);
    if (!grants) return [];
    return Array.from(grants.entries()).map(([tool, uses]) => ({
      tool,
      uses: Number.isFinite(uses) ? uses : 'session',
    }));
  }

  private hasSessionGrant(sessionId: string | undefined, tool: string): boolean {
    if (!sessionId) return false;
    const grants = this.sessionGrants.get(sessionId);
    if (!grants) return false;
    const uses = grants.get(tool);
    if (uses === undefined) return false;
    if (!Number.isFinite(uses)) return true;
    const next = uses - 1;
    if (next <= 0) grants.delete(tool);
    else grants.set(tool, next);
    return true;
  }

  public listGrants(): Array<{ tool: string; uses: number }> {
    return Array.from(this.grants.entries())
      .map(([tool, uses]) => ({ tool, uses }))
      .sort((a, b) => a.tool.localeCompare(b.tool));
  }

  public canCallPcpTool(tool: string, sessionId?: string): ToolPolicyDecision {
    const key = normalizeToolName(tool);
    if (!key) {
      return { allowed: false, reason: 'Invalid tool name.', promptable: false };
    }

    if (this.mode === 'privileged') {
      return { allowed: true, reason: 'Tool mode is privileged.' };
    }

    if (matchesAnyPolicyPattern(key, this.denyTools)) {
      return { allowed: false, reason: 'Tool is explicitly denied by policy.', promptable: false };
    }

    if (matchesAnyPolicyPattern(key, this.safeTools)) {
      return { allowed: true, reason: 'Tool is in safe PCP allowlist.' };
    }

    if (matchesAnyPolicyPattern(key, this.allowTools)) {
      return { allowed: true, reason: 'Tool is explicitly allowlisted in policy.' };
    }

    if (this.hasSessionGrant(sessionId, key)) {
      return { allowed: true, reason: 'Tool is granted for this PCP session.' };
    }

    if (matchesAnyPolicyPattern(key, this.promptTools)) {
      return {
        allowed: false,
        reason: 'Tool requires explicit per-call confirmation by policy.',
        promptable: true,
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
        'Tool blocked by policy. Allow once, allow this session, persist allow, or use /tools privileged.',
      promptable: true,
    };
  }
}
