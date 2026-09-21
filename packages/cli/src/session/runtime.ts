import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface RuntimeSessionRecord {
  inkSessionId: string;
  backend: string;
  sbSlug?: string;
  sbId?: string;
  studioId?: string;
  threadKey?: string;
  gitBranch?: string;
  runtimeLinkId?: string;
  backendSessionId?: string;
  backendSessionIds?: string[];
  startedAt?: string;
  updatedAt: string;
}

interface RuntimeSessionState {
  version: 1;
  current?: {
    inkSessionId: string;
    backend: string;
    sbSlug?: string;
    sbId?: string;
    studioId?: string;
    updatedAt: string;
  };
  sessions: RuntimeSessionRecord[];
}

const RUNTIME_STATE_FILE = 'sessions.json';

function getRuntimeDir(cwd: string): string {
  return join(cwd, '.ink', 'runtime');
}

function getRuntimeStatePath(cwd: string): string {
  return join(getRuntimeDir(cwd), RUNTIME_STATE_FILE);
}

function ensureRuntimeDir(cwd: string): void {
  mkdirSync(getRuntimeDir(cwd), { recursive: true });
}

function defaultState(): RuntimeSessionState {
  return {
    version: 1,
    sessions: [],
  };
}

export function readRuntimeState(cwd: string): RuntimeSessionState {
  const filePath = getRuntimeStatePath(cwd);
  if (!existsSync(filePath)) return defaultState();

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<RuntimeSessionState>;
    // sessions.json is still version 1 and every record written before the
    // agentId -> sbSlug rename carries `agentId`. The owner match below keys on
    // sbSlug, so an un-normalized record never matches and the upsert inserts a
    // DUPLICATE instead of merging the previous backend-session lineage
    // (Lumen, PR #635). Normalize on read, current included.
    // Records written before a rename carry the old key. Without this the
    // type guard below drops them, which loses every legacy row and the
    // `current` pointer. agentId -> sbSlug came from PR #635;
    // pcpSessionId -> inkSessionId from #659.
    const LEGACY_KEYS: ReadonlyArray<readonly [string, string]> = [
      ['agentId', 'sbSlug'],
      ['pcpSessionId', 'inkSessionId'],
    ];
    const withSlug = (row: unknown): unknown => {
      if (!row || typeof row !== 'object') return row;
      let out = row as Record<string, unknown>;
      for (const [legacy, current] of LEGACY_KEYS) {
        if (out[current] === undefined && typeof out[legacy] === 'string') {
          out = { ...out, [current]: out[legacy] };
        }
      }
      return out;
    };
    if (Array.isArray(parsed.sessions)) {
      parsed.sessions = parsed.sessions.map(withSlug) as typeof parsed.sessions;
    }
    if (parsed.current) {
      parsed.current = withSlug(parsed.current) as typeof parsed.current;
    }
    const sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions.filter(
          (s): s is RuntimeSessionRecord =>
            !!s &&
            typeof s === 'object' &&
            typeof s.inkSessionId === 'string' &&
            typeof s.backend === 'string' &&
            typeof s.updatedAt === 'string'
        )
      : [];

    const current =
      parsed.current &&
      typeof parsed.current.inkSessionId === 'string' &&
      typeof parsed.current.backend === 'string' &&
      typeof parsed.current.updatedAt === 'string'
        ? parsed.current
        : undefined;

    return {
      version: 1,
      sessions,
      ...(current ? { current } : {}),
    };
  } catch {
    return defaultState();
  }
}

export function writeRuntimeState(cwd: string, state: RuntimeSessionState): void {
  ensureRuntimeDir(cwd);
  writeFileSync(getRuntimeStatePath(cwd), JSON.stringify(state, null, 2));
}

export function upsertRuntimeSession(
  cwd: string,
  input: Omit<RuntimeSessionRecord, 'updatedAt'> & { updatedAt?: string }
): RuntimeSessionRecord {
  // NOTE: This is a best-effort local runtime cache (non-atomic read/modify/write).
  // Concurrent writers can race and last-write-wins.
  const state = readRuntimeState(cwd);
  const now = input.updatedAt || new Date().toISOString();

  const next: RuntimeSessionRecord = {
    ...input,
    updatedAt: now,
  };

  const idx = state.sessions.findIndex(
    (s) =>
      s.inkSessionId === next.inkSessionId &&
      s.backend === next.backend &&
      s.sbSlug === next.sbSlug &&
      s.studioId === next.studioId
  );

  const mergeSessionIds = (
    existing?: RuntimeSessionRecord,
    incoming?: RuntimeSessionRecord
  ): string[] => {
    const ids = new Set<string>();

    const add = (value: unknown): void => {
      if (typeof value === 'string' && value.trim()) ids.add(value.trim());
    };

    for (const id of existing?.backendSessionIds || []) add(id);
    add(existing?.backendSessionId);

    for (const id of incoming?.backendSessionIds || []) add(id);
    add(incoming?.backendSessionId);

    return [...ids];
  };

  if (idx >= 0) {
    const existing = state.sessions[idx];
    const merged = { ...existing, ...next };
    const backendSessionIds = mergeSessionIds(existing, next);
    if (backendSessionIds.length > 0) {
      merged.backendSessionIds = backendSessionIds;
      if (!merged.backendSessionId) {
        merged.backendSessionId = backendSessionIds[backendSessionIds.length - 1];
      }
    }
    state.sessions[idx] = merged;
  } else {
    const backendSessionIds = mergeSessionIds(undefined, next);
    if (backendSessionIds.length > 0) {
      next.backendSessionIds = backendSessionIds;
      if (!next.backendSessionId) {
        next.backendSessionId = backendSessionIds[backendSessionIds.length - 1];
      }
    }
    state.sessions.push(next);
  }

  writeRuntimeState(cwd, state);
  return idx >= 0 ? state.sessions[idx] : next;
}

export function setCurrentRuntimeSession(
  cwd: string,
  inkSessionId: string,
  backend: string,
  options?: { sbSlug?: string; sbId?: string; studioId?: string }
): void {
  const state = readRuntimeState(cwd);
  state.current = {
    inkSessionId,
    backend,
    ...(options?.sbSlug ? { sbSlug: options.sbSlug } : {}),
    ...(options?.sbId ? { sbId: options.sbId } : {}),
    ...(options?.studioId ? { studioId: options.studioId } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeRuntimeState(cwd, state);
}

export function listRuntimeSessions(cwd: string, backend?: string): RuntimeSessionRecord[] {
  const state = readRuntimeState(cwd);
  const sessions = backend ? state.sessions.filter((s) => s.backend === backend) : state.sessions;
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function findRuntimeSessionByLinkId(
  cwd: string,
  runtimeLinkId: string,
  options?: { backend?: string; sbSlug?: string; studioId?: string }
): RuntimeSessionRecord | undefined {
  if (!runtimeLinkId.trim()) return undefined;

  const sessions = listRuntimeSessions(cwd, options?.backend);
  return sessions.find(
    (session) =>
      session.runtimeLinkId === runtimeLinkId &&
      (!options?.sbSlug || session.sbSlug === options.sbSlug) &&
      (!options?.studioId || session.studioId === options.studioId)
  );
}

export function getCurrentRuntimeSession(
  cwd: string,
  backend?: string
): RuntimeSessionRecord | undefined {
  const state = readRuntimeState(cwd);

  if (state.current) {
    const current = state.sessions.find(
      (s) =>
        s.inkSessionId === state.current!.inkSessionId &&
        s.backend === state.current!.backend &&
        (!state.current!.sbSlug || s.sbSlug === state.current!.sbSlug) &&
        (!state.current!.sbId || s.sbId === state.current!.sbId) &&
        (!state.current!.studioId || s.studioId === state.current!.studioId) &&
        (!backend || s.backend === backend)
    );
    if (current) return current;
  }

  const sessions = listRuntimeSessions(cwd, backend);
  return sessions[0];
}
