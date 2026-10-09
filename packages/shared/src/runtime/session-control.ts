/** Durable selections, not tool grants. A sole owner appends these to its existing log. */
export interface SelectedSkill {
  name: string;
  path: string;
  source: string;
  trustLevel: 'trusted' | 'local' | 'untrusted';
  contentDigest: string;
  provenance?: {
    registry?: string;
    installSource?: string;
    sourceUrl?: string;
    installedAt?: string;
    digest?: string;
    trusted?: boolean;
  };
}
export interface SessionSelection {
  /** Absent means inherit launch configuration; null explicitly resets the model. */
  model?: string | null;
  skills: SelectedSkill[];
}
export type SessionControlRequest = { controlId: string } & (
  | { action: 'model'; model: string | null }
  | { action: 'skill_use'; name: string }
  | { action: 'skill_clear'; name?: string }
);
export interface SessionControlReceipt {
  controlId: string;
  status: 'pending' | 'applied' | 'refused' | 'unknown';
  reason?: string;
  eid?: number;
}
export interface SessionControlRecord extends Record<string, unknown> {
  type: 'session_control';
  version: 1;
  controlId: string;
  backend: string;
  selection: SessionSelection;
  reason?: 'replay_skill_removed';
}
export const MAX_SELECTED_SKILLS = 16;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((key) => allowed.includes(key));

/** Strict, bounded request vocabulary; no arbitrary slash execution or policy mutation. */
export function parseSessionControl(value: unknown): SessionControlRequest | undefined {
  if (!object(value) || !text(value.controlId, 128)) return undefined;
  if (
    value.action === 'model' &&
    keys(value, ['controlId', 'action', 'model']) &&
    (value.model === null || text(value.model, 160))
  )
    return { controlId: value.controlId, action: 'model', model: value.model };
  if (
    value.action === 'skill_use' &&
    keys(value, ['controlId', 'action', 'name']) &&
    text(value.name, 256)
  )
    return { controlId: value.controlId, action: 'skill_use', name: value.name };
  if (
    value.action === 'skill_clear' &&
    keys(value, ['controlId', 'action', 'name']) &&
    (value.name === undefined || text(value.name, 256))
  )
    return {
      controlId: value.controlId,
      action: 'skill_clear',
      ...(value.name ? { name: value.name } : {}),
    };
  return undefined;
}

export function readSessionControl(event: Record<string, unknown>): SessionControlRecord {
  const s = event.selection;
  if (
    event.type !== 'session_control' ||
    event.version !== 1 ||
    !text(event.controlId, 128) ||
    !text(event.backend, 80) ||
    !object(s) ||
    !keys(s, ['model', 'skills']) ||
    (s.model !== undefined && s.model !== null && !text(s.model, 160)) ||
    !Array.isArray(s.skills) ||
    s.skills.length > MAX_SELECTED_SKILLS
  )
    throw new Error('Invalid or unsupported session control record');
  for (const skill of s.skills) {
    if (
      !object(skill) ||
      !keys(skill, ['name', 'path', 'source', 'trustLevel', 'contentDigest', 'provenance']) ||
      !text(skill.name, 256) ||
      !text(skill.path, 4096) ||
      !text(skill.source, 128) ||
      typeof skill.trustLevel !== 'string' ||
      !['trusted', 'local', 'untrusted'].includes(skill.trustLevel) ||
      typeof skill.contentDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(skill.contentDigest)
    )
      throw new Error('Invalid session skill reference');
    if (skill.provenance !== undefined) {
      const p = skill.provenance;
      if (
        !object(p) ||
        !keys(p, ['registry', 'installSource', 'sourceUrl', 'installedAt', 'digest', 'trusted']) ||
        Object.entries(p).some(([key, value]) =>
          key === 'trusted' ? typeof value !== 'boolean' : !text(value, 4096)
        )
      )
        throw new Error('Invalid session skill provenance');
    }
  }
  if (new Set(s.skills.map((skill) => skill.path)).size !== s.skills.length)
    throw new Error('Duplicate session skill reference');
  return structuredClone(event) as SessionControlRecord;
}
