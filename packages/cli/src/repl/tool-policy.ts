import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import * as sharedToolPolicyCore from '@inkstand/shared';

export type ToolGroupMap = Record<string, string[]>;

function requireSharedToolPolicyExport<T>(name: string): T {
  const value = (sharedToolPolicyCore as Record<string, unknown>)[name];
  if (typeof value !== 'function') {
    throw new Error(
      `@inkstand/shared is missing required export "${name}". ` +
        'Rebuild shared + cli: yarn workspace @inkstand/cli build'
    );
  }
  return value as T;
}

const expandPolicySpecs =
  requireSharedToolPolicyExport<(specs: string[], groups: ToolGroupMap) => string[]>(
    'expandPolicySpecs'
  );
const matchesAnyPolicyPattern =
  requireSharedToolPolicyExport<(value: string, patterns: Iterable<string>) => boolean>(
    'matchesAnyPolicyPattern'
  );
const normalizePolicyToken =
  requireSharedToolPolicyExport<(value: string) => string>('normalizePolicyToken');

export { expandPolicySpecs };

export type ToolMode = 'backend' | 'off' | 'privileged';
export type SkillTrustMode = 'all' | 'trusted-only';
export type SessionVisibility = 'self' | 'thread' | 'studio' | 'workspace' | 'agent' | 'all';
export type ToolPolicyScopeKind = 'global' | 'workspace' | 'agent' | 'studio';

export interface ToolPolicyScopeRef {
  scope: ToolPolicyScopeKind;
  id?: string;
}

export interface ToolPolicyContext {
  agentId?: string;
  workspaceId?: string;
  studioId?: string;
}

export interface ToolPolicyDecision {
  allowed: boolean;
  reason: string;
  promptable?: boolean;
}

export interface SessionAccessQuery {
  requester: {
    sessionId?: string;
    threadKey?: string;
    studioId?: string;
    workspaceId?: string;
    agentId?: string;
  };
  target: {
    sessionId?: string;
    threadKey?: string;
    studioId?: string;
    workspaceId?: string;
    agentId?: string;
  };
  action?: 'list' | 'attach' | 'events' | 'inbox';
}

export interface ToolPolicyScopeSnapshot {
  scope: ToolPolicyScopeRef;
  label: string;
  mode?: ToolMode;
  skillTrustMode?: SkillTrustMode;
  sessionVisibility?: SessionVisibility;
  safeTools: string[];
  allowTools: string[];
  denyTools: string[];
  promptTools: string[];
  grants: Array<{ tool: string; uses: number }>;
  readPathAllow: string[];
  writePathAllow: string[];
  allowedSkills: string[];
}

export interface BackendToolGate {
  mode: ToolMode;
  allowedTools: string[];
  unresolvedPatterns: string[];
}

export interface SetMutationScopeResult {
  success: boolean;
  message: string;
  scope?: ToolPolicyScopeRef;
}

export interface ToolPolicyOptions {
  persist?: boolean;
  policyPath?: string;
  context?: ToolPolicyContext;
  mutationScope?: ToolPolicyScopeRef;
}

interface PersistedToolPolicyRules {
  mode?: ToolMode;
  skillTrustMode?: SkillTrustMode;
  sessionVisibility?: SessionVisibility;
  safeTools?: string[];
  allowTools?: string[];
  denyTools?: string[];
  promptTools?: string[];
  grants?: Record<string, number>;
  readPathAllow?: string[];
  writePathAllow?: string[];
  allowedSkills?: string[];
}

interface PersistedToolPolicyV1 extends PersistedToolPolicyRules {
  version?: 1;
}

interface PersistedToolPolicyV2 {
  version: 2;
  scopes?: {
    global?: PersistedToolPolicyRules;
    workspace?: Record<string, PersistedToolPolicyRules>;
    agent?: Record<string, PersistedToolPolicyRules>;
    studio?: Record<string, PersistedToolPolicyRules>;
  };
}

interface ToolPolicyRulesState {
  mode?: ToolMode;
  skillTrustMode?: SkillTrustMode;
  sessionVisibility?: SessionVisibility;
  safeTools: Set<string>;
  allowTools: Set<string>;
  denyTools: Set<string>;
  promptTools: Set<string>;
  grants: Map<string, number>;
  readPathAllow: string[];
  writePathAllow: string[];
  allowedSkills: Set<string>;
}

const DEFAULT_POLICY_PATH = join(homedir(), '.ink', 'security', 'tool-policy.json');

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
  'list_workspaces',
  'list_studios',
  'get_workspace',
  'get_studio',
  'get_timezone',
  'get_focus',
]);

export const TOOL_GROUPS: ToolGroupMap = {
  'group:ink-safe': Array.from(DEFAULT_SAFE_PCP_TOOLS),
  'group:ink-comms': ['send_to_inbox', 'trigger_agent', 'send_response'],
  'group:ink-memory': ['remember', 'recall', 'forget', 'update_memory', 'restore_memory'],
  'group:ink-session': [
    'start_session',
    'update_session_phase',
    'get_session',
    'list_sessions',
    'end_session',
  ],
};

const MODE_RANK: Record<ToolMode, number> = {
  off: 0,
  backend: 1,
  privileged: 2,
};

const DEFAULT_SESSION_VISIBILITY: SessionVisibility = 'agent';

function normalizeToolName(name: string): string {
  return normalizePolicyToken(name);
}

function normalizeScopeId(id: string): string {
  return id.trim().toLowerCase();
}

function normalizeScopeLabel(scope: ToolPolicyScopeRef): string {
  if (scope.scope === 'global') return 'global';
  return `${scope.scope}:${scope.id || '(unset)'}`;
}

function normalizePathPattern(pattern: string): string {
  return pattern.trim();
}

function createRules(options?: {
  mode?: ToolMode;
  skillTrustMode?: SkillTrustMode;
  sessionVisibility?: SessionVisibility;
  includeDefaultSafeTools?: boolean;
}): ToolPolicyRulesState {
  const safeTools = new Set<string>();
  if (options?.includeDefaultSafeTools) {
    for (const tool of DEFAULT_SAFE_PCP_TOOLS) safeTools.add(tool);
  }

  return {
    mode: options?.mode,
    skillTrustMode: options?.skillTrustMode,
    sessionVisibility: options?.sessionVisibility,
    safeTools,
    allowTools: new Set<string>(),
    denyTools: new Set<string>(),
    promptTools: new Set<string>(),
    grants: new Map<string, number>(),
    readPathAllow: [],
    writePathAllow: [],
    allowedSkills: new Set<string>(),
  };
}

function collectRulePatterns(rule: ToolPolicyRulesState): string[] {
  return Array.from(new Set([...rule.safeTools, ...rule.allowTools]));
}

function isExactToolToken(token: string): boolean {
  return token.length > 0 && !token.includes('*');
}

function normalizeStringArray(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function cloneContext(context: ToolPolicyContext): ToolPolicyContext {
  return {
    agentId: context.agentId,
    workspaceId: context.workspaceId,
    studioId: context.studioId,
  };
}

function modeFromRank(rank: number): ToolMode {
  if (rank <= MODE_RANK.off) return 'off';
  if (rank >= MODE_RANK.privileged) return 'privileged';
  return 'backend';
}

function isValidSessionVisibility(value: string | undefined): value is SessionVisibility {
  return Boolean(
    value && ['self', 'thread', 'studio', 'workspace', 'agent', 'all'].includes(value)
  );
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

function addPathSpec(target: string[], raw: string): string[] {
  const normalized = normalizePathPattern(raw);
  if (!normalized) return target;
  return Array.from(new Set([...target, normalized]));
}

function hasAnyRules(rule: ToolPolicyRulesState): boolean {
  return Boolean(
    rule.mode ||
    rule.skillTrustMode ||
    rule.sessionVisibility ||
    rule.allowTools.size ||
    rule.denyTools.size ||
    rule.promptTools.size ||
    rule.grants.size ||
    rule.readPathAllow.length ||
    rule.writePathAllow.length ||
    rule.allowedSkills.size ||
    rule.safeTools.size
  );
}

function sanitizeGrants(grants: Record<string, number> | undefined): Map<string, number> {
  const next = new Map<string, number>();
  for (const [tool, uses] of Object.entries(grants || {})) {
    const key = normalizeToolName(tool);
    if (!key) continue;
    next.set(key, Math.max(0, Number(uses) || 0));
  }
  return next;
}

export class ToolPolicyState {
  private persist: boolean;
  private policyPath: string;
  private context: ToolPolicyContext = {};
  private mutationScope: ToolPolicyScopeRef = { scope: 'global' };

  private globalRules: ToolPolicyRulesState;
  private workspaceRules = new Map<string, ToolPolicyRulesState>();
  private agentRules = new Map<string, ToolPolicyRulesState>();
  private studioRules = new Map<string, ToolPolicyRulesState>();

  private sessionGrants = new Map<string, Map<string, number>>();

  constructor(initialMode: ToolMode = 'backend', options?: ToolPolicyOptions) {
    this.persist = options?.persist ?? true;
    this.policyPath = options?.policyPath || DEFAULT_POLICY_PATH;
    this.globalRules = createRules({
      mode: initialMode,
      skillTrustMode: 'all',
      sessionVisibility: DEFAULT_SESSION_VISIBILITY,
      includeDefaultSafeTools: true,
    });

    if (this.persist) {
      this.loadFromDisk();
    }

    if (options?.context) {
      this.setContext(options.context);
    }

    if (options?.mutationScope) {
      this.setMutationScope(options.mutationScope.scope, options.mutationScope.id);
    }
  }

  private getScopeMap(
    scope: Exclude<ToolPolicyScopeKind, 'global'>
  ): Map<string, ToolPolicyRulesState> {
    if (scope === 'workspace') return this.workspaceRules;
    if (scope === 'agent') return this.agentRules;
    return this.studioRules;
  }

  private resolveContextScopeId(scope: Exclude<ToolPolicyScopeKind, 'global'>): string | undefined {
    const raw =
      scope === 'workspace'
        ? this.context.workspaceId
        : scope === 'agent'
          ? this.context.agentId
          : this.context.studioId;
    if (!raw) return undefined;
    const normalized = normalizeScopeId(raw);
    return normalized || undefined;
  }

  private normalizeScope(scope: ToolPolicyScopeKind, id?: string): ToolPolicyScopeRef | undefined {
    if (scope === 'global') return { scope: 'global' };
    const resolved = id ? normalizeScopeId(id) : this.resolveContextScopeId(scope);
    if (!resolved) return undefined;
    return { scope, id: resolved };
  }

  private getRulesForScope(
    scope: ToolPolicyScopeRef,
    create = false
  ): ToolPolicyRulesState | undefined {
    if (scope.scope === 'global') {
      return this.globalRules;
    }

    if (!scope.id) return undefined;
    const map = this.getScopeMap(scope.scope);
    const key = normalizeScopeId(scope.id);
    const existing = map.get(key);
    if (existing) return existing;
    if (!create) return undefined;

    const created = createRules();
    map.set(key, created);
    return created;
  }

  private getActiveScopeRefs(): ToolPolicyScopeRef[] {
    const refs: ToolPolicyScopeRef[] = [{ scope: 'global' }];

    const workspaceId = this.resolveContextScopeId('workspace');
    if (workspaceId) refs.push({ scope: 'workspace', id: workspaceId });

    const agentId = this.resolveContextScopeId('agent');
    if (agentId) refs.push({ scope: 'agent', id: agentId });

    const studioId = this.resolveContextScopeId('studio');
    if (studioId) refs.push({ scope: 'studio', id: studioId });

    return refs;
  }

  private getActiveScopeRules(): Array<{ ref: ToolPolicyScopeRef; rules: ToolPolicyRulesState }> {
    return this.getActiveScopeRefs()
      .map((ref) => {
        const rules = this.getRulesForScope(ref, false);
        return rules ? { ref, rules } : undefined;
      })
      .filter((entry): entry is { ref: ToolPolicyScopeRef; rules: ToolPolicyRulesState } =>
        Boolean(entry)
      );
  }

  private applyPersistedRules(
    target: ToolPolicyRulesState,
    data: PersistedToolPolicyRules | undefined
  ): void {
    if (!data) return;

    if (data.mode === 'backend' || data.mode === 'off' || data.mode === 'privileged') {
      target.mode = data.mode;
    }
    if (data.skillTrustMode === 'all' || data.skillTrustMode === 'trusted-only') {
      target.skillTrustMode = data.skillTrustMode;
    }
    if (isValidSessionVisibility(data.sessionVisibility)) {
      target.sessionVisibility = data.sessionVisibility;
    }

    for (const tool of data.safeTools || []) addToolSpec(target.safeTools, tool);
    for (const tool of data.allowTools || []) addToolSpec(target.allowTools, tool);
    for (const tool of data.denyTools || []) addToolSpec(target.denyTools, tool);
    for (const tool of data.promptTools || []) addToolSpec(target.promptTools, tool);

    target.grants = sanitizeGrants(data.grants);

    target.readPathAllow = normalizeStringArray(data.readPathAllow);
    target.writePathAllow = normalizeStringArray(data.writePathAllow);
    target.allowedSkills = new Set(normalizeStringArray(data.allowedSkills));
  }

  private serializeRules(rules: ToolPolicyRulesState): PersistedToolPolicyRules {
    return {
      mode: rules.mode,
      skillTrustMode: rules.skillTrustMode,
      sessionVisibility: rules.sessionVisibility,
      safeTools: Array.from(rules.safeTools).sort(),
      allowTools: Array.from(rules.allowTools).sort(),
      denyTools: Array.from(rules.denyTools).sort(),
      promptTools: Array.from(rules.promptTools).sort(),
      grants: Object.fromEntries(rules.grants.entries()),
      readPathAllow: [...rules.readPathAllow],
      writePathAllow: [...rules.writePathAllow],
      allowedSkills: Array.from(rules.allowedSkills).sort(),
    };
  }

  private serializeScopedMap(
    map: Map<string, ToolPolicyRulesState>
  ): Record<string, PersistedToolPolicyRules> {
    const output: Record<string, PersistedToolPolicyRules> = {};
    for (const [id, rules] of map.entries()) {
      if (!hasAnyRules(rules)) continue;
      output[id] = this.serializeRules(rules);
    }
    return output;
  }

  private saveToDisk(): void {
    if (!this.persist) return;

    const payload: PersistedToolPolicyV2 = {
      version: 2,
      scopes: {
        global: this.serializeRules(this.globalRules),
      },
    };

    const workspace = this.serializeScopedMap(this.workspaceRules);
    if (Object.keys(workspace).length > 0) payload.scopes!.workspace = workspace;

    const agent = this.serializeScopedMap(this.agentRules);
    if (Object.keys(agent).length > 0) payload.scopes!.agent = agent;

    const studio = this.serializeScopedMap(this.studioRules);
    if (Object.keys(studio).length > 0) payload.scopes!.studio = studio;

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
      const parsed = JSON.parse(readFileSync(this.policyPath, 'utf-8')) as
        | PersistedToolPolicyV1
        | PersistedToolPolicyV2;

      if ((parsed as PersistedToolPolicyV2).version === 2) {
        const v2 = parsed as PersistedToolPolicyV2;
        this.applyPersistedRules(this.globalRules, v2.scopes?.global);

        this.workspaceRules.clear();
        for (const [id, data] of Object.entries(v2.scopes?.workspace || {})) {
          const normalizedId = normalizeScopeId(id);
          if (!normalizedId) continue;
          const rules = createRules();
          this.applyPersistedRules(rules, data);
          this.workspaceRules.set(normalizedId, rules);
        }

        this.agentRules.clear();
        for (const [id, data] of Object.entries(v2.scopes?.agent || {})) {
          const normalizedId = normalizeScopeId(id);
          if (!normalizedId) continue;
          const rules = createRules();
          this.applyPersistedRules(rules, data);
          this.agentRules.set(normalizedId, rules);
        }

        this.studioRules.clear();
        for (const [id, data] of Object.entries(v2.scopes?.studio || {})) {
          const normalizedId = normalizeScopeId(id);
          if (!normalizedId) continue;
          const rules = createRules();
          this.applyPersistedRules(rules, data);
          this.studioRules.set(normalizedId, rules);
        }

        return;
      }

      const legacy = parsed as PersistedToolPolicyV1;
      this.applyPersistedRules(this.globalRules, legacy);
    } catch {
      // Ignore malformed policy.
    }
  }

  private resolveMutationScope(explicit?: ToolPolicyScopeRef): ToolPolicyScopeRef {
    if (!explicit) return this.mutationScope;
    const resolved = this.normalizeScope(explicit.scope, explicit.id);
    return resolved || this.mutationScope;
  }

  private resolveRulesForMutation(explicit?: ToolPolicyScopeRef): ToolPolicyRulesState {
    const target = this.resolveMutationScope(explicit);
    return this.getRulesForScope(target, true)!;
  }

  private listActivePatternSet(
    selector: (rules: ToolPolicyRulesState) => Iterable<string>
  ): Set<string> {
    const values = new Set<string>();
    for (const { rules } of this.getActiveScopeRules()) {
      for (const value of selector(rules)) values.add(value);
    }
    return values;
  }

  private matchesAnyDeniedTool(tool: string): boolean {
    for (const { rules } of this.getActiveScopeRules()) {
      if (matchesAnyPolicyPattern(tool, rules.denyTools)) {
        return true;
      }
    }
    return false;
  }

  private matchesAnyPromptTool(tool: string): boolean {
    for (const { rules } of this.getActiveScopeRules()) {
      if (matchesAnyPolicyPattern(tool, rules.promptTools)) {
        return true;
      }
    }
    return false;
  }

  private findAllowFilterBlockingScope(tool: string): string | undefined {
    for (const { ref, rules } of this.getActiveScopeRules()) {
      const allowPatterns = collectRulePatterns(rules);
      if (allowPatterns.length === 0) continue;
      if (!matchesAnyPolicyPattern(tool, allowPatterns)) {
        return normalizeScopeLabel(ref);
      }
    }
    return undefined;
  }

  private consumeScopedGrant(tool: string): {
    consumed: boolean;
    remaining: number;
    scopeLabel?: string;
  } {
    const activeScopes = this.getActiveScopeRules().reverse();
    for (const { ref, rules } of activeScopes) {
      const current = rules.grants.get(tool) || 0;
      if (current <= 0) continue;
      const next = current - 1;
      if (next <= 0) rules.grants.delete(tool);
      else rules.grants.set(tool, next);
      this.saveToDisk();
      return {
        consumed: true,
        remaining: next,
        scopeLabel: normalizeScopeLabel(ref),
      };
    }
    return { consumed: false, remaining: 0 };
  }

  private hasSessionGrant(sessionId: string | undefined, tool: string): boolean {
    if (!sessionId) return false;
    const sid = sessionId.trim();
    if (!sid) return false;

    const grants = this.sessionGrants.get(sid);
    if (!grants) return false;
    const uses = grants.get(tool);
    if (uses === undefined) return false;

    if (!Number.isFinite(uses)) return true;
    const next = uses - 1;
    if (next <= 0) grants.delete(tool);
    else grants.set(tool, next);

    return true;
  }

  private resolveEffectiveMode(): ToolMode {
    const active = this.getActiveScopeRules();
    let rank = MODE_RANK.privileged;

    for (const { rules } of active) {
      if (!rules.mode) continue;
      rank = Math.min(rank, MODE_RANK[rules.mode]);
    }

    return modeFromRank(rank);
  }

  private resolveEffectiveSkillTrustMode(): SkillTrustMode {
    for (const { rules } of this.getActiveScopeRules()) {
      if (rules.skillTrustMode === 'trusted-only') {
        return 'trusted-only';
      }
    }
    return 'all';
  }

  private resolveEffectiveSessionVisibilityRules(): Array<{
    ref: ToolPolicyScopeRef;
    visibility: SessionVisibility;
  }> {
    return this.getActiveScopeRules()
      .map(({ ref, rules }) => {
        if (!rules.sessionVisibility) return undefined;
        return { ref, visibility: rules.sessionVisibility };
      })
      .filter((entry): entry is { ref: ToolPolicyScopeRef; visibility: SessionVisibility } =>
        Boolean(entry)
      );
  }

  private visibilityAllows(visibility: SessionVisibility, query: SessionAccessQuery): boolean {
    const requester = query.requester;
    const target = query.target;
    if (visibility === 'all') return true;
    if (visibility === 'agent') {
      return Boolean(requester.agentId && target.agentId && requester.agentId === target.agentId);
    }
    if (visibility === 'workspace') {
      // Fall back to studioId comparison when workspaceId is absent — the
      // separate workspace concept was removed and callers no longer populate
      // workspaceId on session access queries.
      const rId = requester.workspaceId || requester.studioId;
      const tId = target.workspaceId || target.studioId;
      return Boolean(rId && tId && rId === tId);
    }
    if (visibility === 'studio') {
      return Boolean(
        requester.studioId && target.studioId && requester.studioId === target.studioId
      );
    }
    if (visibility === 'thread') {
      if (requester.threadKey && target.threadKey) {
        return requester.threadKey === target.threadKey;
      }
      if (requester.sessionId && target.sessionId) {
        return requester.sessionId === target.sessionId;
      }
      return false;
    }
    // self
    return Boolean(
      requester.sessionId && target.sessionId && requester.sessionId === target.sessionId
    );
  }

  public setContext(context: ToolPolicyContext): void {
    const studioNorm = context.studioId ? normalizeScopeId(context.studioId) : undefined;
    this.context = {
      agentId: context.agentId ? normalizeScopeId(context.agentId) : undefined,
      // Derive workspaceId from studioId when not explicitly provided — the
      // separate workspace concept was removed but the scope layer remains for
      // backwards-compatible policy files.
      workspaceId: context.workspaceId ? normalizeScopeId(context.workspaceId) : studioNorm,
      studioId: studioNorm,
    };

    if (this.mutationScope.scope !== 'global') {
      const normalized = this.normalizeScope(this.mutationScope.scope, this.mutationScope.id);
      if (normalized) {
        this.mutationScope = normalized;
      }
    }
  }

  public getContext(): ToolPolicyContext {
    return cloneContext(this.context);
  }

  public setMutationScope(scope: ToolPolicyScopeKind, id?: string): SetMutationScopeResult {
    const resolved = this.normalizeScope(scope, id);
    if (!resolved) {
      return {
        success: false,
        message: `No ${scope} scope id available in current context.`,
      };
    }

    this.mutationScope = resolved;
    return {
      success: true,
      message: `Mutation scope set to ${normalizeScopeLabel(resolved)}.`,
      scope: { ...resolved },
    };
  }

  public getMutationScope(): ToolPolicyScopeRef {
    return { ...this.mutationScope };
  }

  public getMutationScopeLabel(): string {
    return normalizeScopeLabel(this.mutationScope);
  }

  public listActiveScopeLabels(): string[] {
    return this.getActiveScopeRefs().map((ref) => normalizeScopeLabel(ref));
  }

  public listActiveScopeSnapshots(): ToolPolicyScopeSnapshot[] {
    return this.getActiveScopeRefs()
      .map((ref) => {
        const rules = this.getRulesForScope(ref, false) || createRules();
        return {
          scope: { ...ref },
          label: normalizeScopeLabel(ref),
          mode: rules.mode,
          skillTrustMode: rules.skillTrustMode,
          sessionVisibility: rules.sessionVisibility,
          safeTools: Array.from(rules.safeTools).sort(),
          allowTools: Array.from(rules.allowTools).sort(),
          denyTools: Array.from(rules.denyTools).sort(),
          promptTools: Array.from(rules.promptTools).sort(),
          grants: Array.from(rules.grants.entries())
            .map(([tool, uses]) => ({ tool, uses }))
            .sort((a, b) => a.tool.localeCompare(b.tool)),
          readPathAllow: [...rules.readPathAllow],
          writePathAllow: [...rules.writePathAllow],
          allowedSkills: Array.from(rules.allowedSkills).sort(),
        } satisfies ToolPolicyScopeSnapshot;
      })
      .filter(
        (snapshot, index) =>
          index === 0 || hasAnyRules(this.getRulesForScope(snapshot.scope, false) || createRules())
      );
  }

  public getMode(): ToolMode {
    return this.resolveEffectiveMode();
  }

  public setMode(mode: ToolMode, scope?: ToolPolicyScopeRef): void {
    const rules = this.resolveRulesForMutation(scope);
    rules.mode = mode;
    this.saveToDisk();
  }

  public getPolicyPath(): string {
    return this.policyPath;
  }

  public getSkillTrustMode(): SkillTrustMode {
    return this.resolveEffectiveSkillTrustMode();
  }

  public setSkillTrustMode(mode: SkillTrustMode, scope?: ToolPolicyScopeRef): void {
    const rules = this.resolveRulesForMutation(scope);
    rules.skillTrustMode = mode;
    this.saveToDisk();
  }

  public getSessionVisibility(): SessionVisibility {
    const active = this.resolveEffectiveSessionVisibilityRules();
    if (active.length === 0) return DEFAULT_SESSION_VISIBILITY;
    return active[active.length - 1]!.visibility;
  }

  public setSessionVisibility(visibility: SessionVisibility, scope?: ToolPolicyScopeRef): void {
    const rules = this.resolveRulesForMutation(scope);
    rules.sessionVisibility = visibility;
    this.saveToDisk();
  }

  public canAccessSession(query: SessionAccessQuery): ToolPolicyDecision {
    const rules = this.resolveEffectiveSessionVisibilityRules();
    for (const rule of rules) {
      if (!this.visibilityAllows(rule.visibility, query)) {
        return {
          allowed: false,
          reason: `Session access blocked by ${normalizeScopeLabel(rule.ref)} visibility=${rule.visibility}.`,
          promptable: false,
        };
      }
    }
    return { allowed: true, reason: 'Session access allowed by visibility policy.' };
  }

  public clearScopeRules(scope?: ToolPolicyScopeRef): SetMutationScopeResult {
    const target = this.resolveMutationScope(scope);
    if (target.scope === 'global') {
      this.globalRules = createRules({
        mode: 'backend',
        skillTrustMode: 'all',
        sessionVisibility: DEFAULT_SESSION_VISIBILITY,
        includeDefaultSafeTools: true,
      });
      this.saveToDisk();
      return {
        success: true,
        message: 'Reset global policy scope to defaults.',
        scope: { ...target },
      };
    }

    if (!target.id) {
      return { success: false, message: `No ${target.scope} scope id available to reset.` };
    }

    const map = this.getScopeMap(target.scope);
    map.delete(target.id);
    this.saveToDisk();
    return {
      success: true,
      message: `Reset ${normalizeScopeLabel(target)} policy scope.`,
      scope: { ...target },
    };
  }

  public isSkillTrustAllowed(level: 'trusted' | 'local' | 'untrusted'): boolean {
    if (this.resolveEffectiveSkillTrustMode() === 'all') return true;
    return level === 'trusted';
  }

  public listSafeTools(): string[] {
    return Array.from(this.listActivePatternSet((rules) => rules.safeTools)).sort();
  }

  public listAllowTools(): string[] {
    return Array.from(this.listActivePatternSet((rules) => rules.allowTools)).sort();
  }

  public listDenyTools(): string[] {
    return Array.from(this.listActivePatternSet((rules) => rules.denyTools)).sort();
  }

  public listPromptTools(): string[] {
    return Array.from(this.listActivePatternSet((rules) => rules.promptTools)).sort();
  }

  public listReadPathAllow(): string[] {
    const values = new Set<string>();
    for (const { rules } of this.getActiveScopeRules()) {
      for (const value of rules.readPathAllow) values.add(value);
    }
    return Array.from(values);
  }

  public listWritePathAllow(): string[] {
    const values = new Set<string>();
    for (const { rules } of this.getActiveScopeRules()) {
      for (const value of rules.writePathAllow) values.add(value);
    }
    return Array.from(values);
  }

  public listAllowedSkills(): string[] {
    const values = new Set<string>();
    for (const { rules } of this.getActiveScopeRules()) {
      for (const value of rules.allowedSkills) values.add(value);
    }
    return Array.from(values).sort();
  }

  public allowTool(tool: string, scope?: ToolPolicyScopeRef): void {
    const rules = this.resolveRulesForMutation(scope);
    const expanded = expandToolSpec(tool);
    if (expanded.length === 0) return;

    for (const key of expanded) {
      rules.allowTools.add(key);
      rules.denyTools.delete(key);
      rules.promptTools.delete(key);
    }

    this.saveToDisk();
  }

  public denyTool(tool: string, scope?: ToolPolicyScopeRef): void {
    const rules = this.resolveRulesForMutation(scope);
    const expanded = expandToolSpec(tool);
    if (expanded.length === 0) return;

    for (const key of expanded) {
      rules.denyTools.add(key);
      rules.allowTools.delete(key);
      rules.promptTools.delete(key);
    }

    this.saveToDisk();
  }

  public addPromptTool(tool: string, scope?: ToolPolicyScopeRef): void {
    const rules = this.resolveRulesForMutation(scope);
    const expanded = expandToolSpec(tool);
    if (expanded.length === 0) return;

    for (const key of expanded) {
      rules.promptTools.add(key);
      rules.allowTools.delete(key);
      rules.denyTools.delete(key);
    }

    this.saveToDisk();
  }

  public removeToolRule(tool: string, scope?: ToolPolicyScopeRef): void {
    const rules = this.resolveRulesForMutation(scope);
    const expanded = expandToolSpec(tool);
    if (expanded.length === 0) return;

    for (const key of expanded) {
      rules.allowTools.delete(key);
      rules.denyTools.delete(key);
      rules.promptTools.delete(key);
    }

    this.saveToDisk();
  }

  public setAllowedSkills(skills: string[], scope?: ToolPolicyScopeRef): void {
    const rules = this.resolveRulesForMutation(scope);
    rules.allowedSkills = new Set(skills.map((skill) => skill.trim()).filter(Boolean));
    this.saveToDisk();
  }

  public allowSkill(skill: string, scope?: ToolPolicyScopeRef): void {
    const rules = this.resolveRulesForMutation(scope);
    const next = skill.trim();
    if (!next) return;
    rules.allowedSkills.add(next);
    this.saveToDisk();
  }

  public isSkillAllowed(skill: string): boolean {
    for (const { rules } of this.getActiveScopeRules()) {
      if (rules.allowedSkills.size === 0) continue;
      if (!matchesAnyPolicyPattern(skill, rules.allowedSkills)) {
        return false;
      }
    }
    return true;
  }

  public canUseBackendTools(): boolean {
    return this.resolveEffectiveMode() !== 'off';
  }

  public getBackendToolGate(): BackendToolGate {
    const mode = this.resolveEffectiveMode();
    if (mode === 'off') {
      return { mode, allowedTools: [], unresolvedPatterns: [] };
    }
    if (mode === 'privileged') {
      return { mode, allowedTools: [], unresolvedPatterns: [] };
    }

    const candidates = new Set<string>();
    const unresolvedPatterns = new Set<string>();
    for (const { rules } of this.getActiveScopeRules()) {
      for (const pattern of collectRulePatterns(rules)) {
        if (isExactToolToken(pattern)) {
          candidates.add(pattern);
        } else {
          unresolvedPatterns.add(pattern);
        }
      }
    }

    const allowedTools = Array.from(candidates)
      .filter((tool) => !this.matchesAnyDeniedTool(tool))
      .filter((tool) => !this.matchesAnyPromptTool(tool))
      .filter((tool) => !this.findAllowFilterBlockingScope(tool))
      .sort();

    return {
      mode,
      allowedTools,
      unresolvedPatterns: Array.from(unresolvedPatterns).sort(),
    };
  }

  public addReadPathAllow(pattern: string, scope?: ToolPolicyScopeRef): void {
    const rules = this.resolveRulesForMutation(scope);
    rules.readPathAllow = addPathSpec(rules.readPathAllow, pattern);
    this.saveToDisk();
  }

  public addWritePathAllow(pattern: string, scope?: ToolPolicyScopeRef): void {
    const rules = this.resolveRulesForMutation(scope);
    rules.writePathAllow = addPathSpec(rules.writePathAllow, pattern);
    this.saveToDisk();
  }

  public isReadPathAllowed(path: string): boolean {
    for (const { rules } of this.getActiveScopeRules()) {
      if (rules.readPathAllow.length === 0) continue;
      if (!matchesAnyPolicyPattern(path, rules.readPathAllow)) {
        return false;
      }
    }
    return true;
  }

  public isWritePathAllowed(path: string): boolean {
    for (const { rules } of this.getActiveScopeRules()) {
      if (rules.writePathAllow.length === 0) continue;
      if (!matchesAnyPolicyPattern(path, rules.writePathAllow)) {
        return false;
      }
    }
    return true;
  }

  public grantTool(tool: string, uses = 1, scope?: ToolPolicyScopeRef): void {
    const rules = this.resolveRulesForMutation(scope);
    const key = normalizeToolName(tool);
    const next = Math.max(1, uses);
    rules.grants.set(key, (rules.grants.get(key) || 0) + next);
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

  public listGrants(): Array<{ tool: string; uses: number }> {
    const merged = new Map<string, number>();
    for (const { rules } of this.getActiveScopeRules()) {
      for (const [tool, uses] of rules.grants.entries()) {
        merged.set(tool, (merged.get(tool) || 0) + uses);
      }
    }

    return Array.from(merged.entries())
      .map(([tool, uses]) => ({ tool, uses }))
      .sort((a, b) => a.tool.localeCompare(b.tool));
  }

  public canCallPcpTool(tool: string, sessionId?: string): ToolPolicyDecision {
    const key = normalizeToolName(tool);
    if (!key) {
      return { allowed: false, reason: 'Invalid tool name.', promptable: false };
    }

    if (this.matchesAnyDeniedTool(key)) {
      return { allowed: false, reason: 'Tool is explicitly denied by policy.', promptable: false };
    }

    if (this.resolveEffectiveMode() === 'privileged') {
      return { allowed: true, reason: 'Tool mode is privileged.' };
    }

    if (this.hasSessionGrant(sessionId, key)) {
      return { allowed: true, reason: 'Tool is granted for this PCP session.' };
    }

    const scopedGrant = this.consumeScopedGrant(key);
    if (scopedGrant.consumed) {
      const suffix = scopedGrant.scopeLabel ? ` in ${scopedGrant.scopeLabel}` : '';
      return {
        allowed: true,
        reason: `One-time grant consumed${suffix} (${scopedGrant.remaining} remaining).`,
      };
    }

    if (this.matchesAnyPromptTool(key)) {
      return {
        allowed: false,
        reason: 'Tool requires explicit per-call confirmation by policy.',
        promptable: true,
      };
    }

    const blockedScope = this.findAllowFilterBlockingScope(key);
    if (blockedScope) {
      return {
        allowed: false,
        reason: `Tool blocked by scoped allowlist (${blockedScope}). Allow once/session or persist allow in that scope.`,
        promptable: true,
      };
    }

    return {
      allowed: true,
      reason: 'Tool allowed by active policy scopes.',
    };
  }
}
