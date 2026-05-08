/**
 * Bash Process Guard
 *
 * Defense-in-depth for bash command execution. NOT a substitute for
 * container isolation — catches common dangerous patterns and provides
 * multi-agent process boundaries.
 *
 * Three layers:
 * 1. Static analysis — block catastrophic commands pre-execution
 * 2. Kill scope enforcement — prevent cross-agent process termination
 * 3. Process registry — track background PIDs per agent
 */

import { logger } from '../../utils/logger';

// --- Types ---

export interface CommandAnalysis {
  blocked: boolean;
  reason?: string;
  isKillCommand: boolean;
  killPidTargets: number[];
}

export interface BashGuardConfig {
  agentId: string;
  /** Block catastrophic commands before execution (default: true) */
  blockDangerousCommands?: boolean;
  /** Enforce kill targeting only agent-owned PIDs (default: true) */
  enforceKillScope?: boolean;
}

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

// --- Dangerous command detection ---

// Fork bomb: function that pipes to itself with backgrounding
// Catches :(){ :|:& };: and named variants like bomb(){ bomb|bomb& };bomb
const FORK_BOMB_RE = /([\w:.]+)\(\)\s*\{\s*\1\s*\|\s*\1\s*&/;

interface DangerousPattern {
  pattern: RegExp;
  reason: string;
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  { pattern: FORK_BOMB_RE, reason: 'fork bomb detected' },
  { pattern: /\bmkfs(?:\.\w+)?\s/, reason: 'filesystem format' },
  { pattern: /\bdd\b[^;|&]*\bof=\/dev\/(?:sd|hd|nvme|vd)/, reason: 'raw disk write' },
  { pattern: /\bshutdown\b/, reason: 'system shutdown' },
  { pattern: /\breboot\b/, reason: 'system reboot' },
  { pattern: /\bpoweroff\b/, reason: 'system poweroff' },
  { pattern: /\binit\s+[06]\b/, reason: 'init level change' },
  { pattern: /\bnsenter\s/, reason: 'namespace entry' },
];

function isRecursiveRootDelete(command: string): boolean {
  const segments = command.split(/[;|&]+/);
  for (const segment of segments) {
    if (!/\brm\b/.test(segment)) continue;
    if (!/-[a-zA-Z]*r/.test(segment) && !/--recursive/.test(segment)) continue;
    const tokens = segment.trim().split(/\s+/);
    const rmIdx = tokens.findIndex((t) => t === 'rm');
    if (rmIdx === -1) continue;
    const pathArgs = tokens.slice(rmIdx + 1).filter((t) => !t.startsWith('-'));
    if (pathArgs.some((t) => t === '/' || t === '/*')) return true;
  }
  return false;
}

// --- Kill command analysis ---

function analyzeKillCommands(command: string): {
  found: boolean;
  allProcesses: boolean;
  initProcess: boolean;
  processGroup: boolean;
  hasUnresolvableTargets: boolean;
  pids: number[];
} {
  const result = {
    found: false,
    allProcesses: false,
    initProcess: false,
    processGroup: false,
    hasUnresolvableTargets: false,
    pids: [] as number[],
  };

  const matches = [...command.matchAll(/\bkill\s+([^;|&\n]+)/g)];
  if (matches.length === 0) return result;
  result.found = true;

  for (const m of matches) {
    const args = m[1].trim();

    // -1 as a PID argument targets all processes
    if (/(?:^|\s)-1(?:\s|$)/.test(args)) {
      result.allProcesses = true;
    }

    // Extract numeric PID targets (non-flag tokens after --)
    // or non-flag tokens that are pure numbers
    const tokens = args.split(/\s+/);
    const dashDashIdx = tokens.indexOf('--');
    const candidates =
      dashDashIdx >= 0 ? tokens.slice(dashDashIdx + 1) : tokens.filter((t) => !t.startsWith('-'));

    for (const t of candidates) {
      // Variable expansion or command substitution — can't resolve statically
      if (/\$/.test(t) || /`/.test(t)) {
        result.hasUnresolvableTargets = true;
        continue;
      }
      const n = parseInt(t, 10);
      if (isNaN(n)) continue;
      if (n === 0) {
        result.processGroup = true;
      } else if (n < 0) {
        result.processGroup = true;
      } else {
        result.pids.push(n);
      }
    }

    // Also check for negative PIDs after -- (process group targets)
    if (dashDashIdx >= 0) {
      for (const t of tokens.slice(dashDashIdx + 1)) {
        if (/^-\d+$/.test(t) && t !== '-1') {
          result.processGroup = true;
        }
      }
    }
  }

  result.initProcess = result.pids.includes(1);
  return result;
}

// --- Public API ---

export function analyzeCommand(command: string): CommandAnalysis {
  const base: CommandAnalysis = { blocked: false, isKillCommand: false, killPidTargets: [] };

  if (isRecursiveRootDelete(command)) {
    return { ...base, blocked: true, reason: 'Blocked: recursive delete at filesystem root' };
  }

  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { ...base, blocked: true, reason: `Blocked: ${reason}` };
    }
  }

  const kill = analyzeKillCommands(command);
  const hasPkillKillall = /\b(pkill|killall)\b/.test(command);

  if (kill.allProcesses) {
    return {
      blocked: true,
      reason: 'Blocked: kill -1 targets all processes',
      isKillCommand: true,
      killPidTargets: kill.pids,
    };
  }

  if (kill.initProcess) {
    return {
      blocked: true,
      reason: 'Blocked: cannot signal PID 1 (init process)',
      isKillCommand: true,
      killPidTargets: kill.pids,
    };
  }

  if (kill.processGroup) {
    return {
      blocked: true,
      reason: 'Blocked: kill targeting process group (PID 0 or negative PID)',
      isKillCommand: true,
      killPidTargets: kill.pids,
    };
  }

  if (kill.hasUnresolvableTargets) {
    return {
      blocked: true,
      reason: 'Blocked: kill with variable/dynamic PID target — cannot verify ownership',
      isKillCommand: true,
      killPidTargets: kill.pids,
    };
  }

  if (hasPkillKillall) {
    return {
      blocked: true,
      reason: 'Blocked: pkill/killall target by name — cannot verify process ownership',
      isKillCommand: true,
      killPidTargets: [],
    };
  }

  return {
    blocked: false,
    isKillCommand: kill.found,
    killPidTargets: kill.pids,
  };
}

// --- Process Registry ---

interface ProcessEntry {
  pid: number;
  agentId: string;
  command: string;
  registeredAt: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class ProcessRegistry {
  private entries = new Map<number, ProcessEntry>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  register(agentId: string, pid: number, command: string): void {
    this.entries.set(pid, { pid, agentId, command, registeredAt: Date.now() });
  }

  isOwned(agentId: string, pid: number): boolean {
    const entry = this.entries.get(pid);
    return !!entry && entry.agentId === agentId;
  }

  getOwner(pid: number): string | undefined {
    return this.entries.get(pid)?.agentId;
  }

  getAgentPids(agentId: string): number[] {
    return [...this.entries.values()].filter((e) => e.agentId === agentId).map((e) => e.pid);
  }

  has(pid: number): boolean {
    return this.entries.has(pid);
  }

  remove(pid: number): void {
    this.entries.delete(pid);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [pid, entry] of this.entries) {
      if (now - entry.registeredAt > this.ttlMs) {
        this.entries.delete(pid);
        continue;
      }
      try {
        process.kill(pid, 0);
      } catch {
        this.entries.delete(pid);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

let _registry: ProcessRegistry | undefined;

export function getProcessRegistry(): ProcessRegistry {
  if (!_registry) _registry = new ProcessRegistry();
  return _registry;
}

export function resetProcessRegistry(): void {
  _registry = undefined;
}

// --- Background PID extraction ---

export function extractBackgroundPids(output: string): number[] {
  const re = /\[\d+\]\s+(\d+)/g;
  const pids: number[] = [];
  let match;
  while ((match = re.exec(output)) !== null) {
    const pid = parseInt(match[1], 10);
    if (pid > 0) pids.push(pid);
  }
  return pids;
}

// --- Guard ---

export function guardBashCommand(command: string, config: BashGuardConfig): GuardResult {
  const analysis = analyzeCommand(command);

  if (config.blockDangerousCommands !== false && analysis.blocked) {
    logger.warn('Bash guard blocked command', {
      agentId: config.agentId,
      command: command.substring(0, 200),
      reason: analysis.reason,
    });
    return { allowed: false, reason: analysis.reason };
  }

  if (
    config.enforceKillScope !== false &&
    analysis.isKillCommand &&
    analysis.killPidTargets.length > 0
  ) {
    const registry = getProcessRegistry();
    const unauthorized = analysis.killPidTargets.filter(
      (pid) => !registry.isOwned(config.agentId, pid)
    );
    if (unauthorized.length > 0) {
      const reason = `Blocked: cannot signal PIDs not owned by this agent: [${unauthorized.join(', ')}]`;
      logger.warn('Bash guard blocked kill', {
        agentId: config.agentId,
        unauthorizedPids: unauthorized,
      });
      return { allowed: false, reason };
    }
  }

  return { allowed: true };
}
