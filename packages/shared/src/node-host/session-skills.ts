/**
 * Existing manual skill activation/release, shared across session hosts.
 * No discovery roots, permission mutation, persistence or input admission here.
 * A hosted adapter must supply asynchronous I/O and its own owner/boundary gate.
 */
import type { DiscoveredSkill, SkillInstruction } from '../providers/skill-discovery.js';
import type { ToolPolicyState } from '../runtime/tool-policy.js';
import { canActivateSkill } from './skill-policy.js';

export interface SessionSkillsPorts {
  state(): { sessionId?: string; activeSkills: SkillInstruction[] };
  policy: ToolPolicyState;
  discover(signal?: AbortSignal): readonly DiscoveredSkill[] | Promise<readonly DiscoveredSkill[]>;
  load(skill: DiscoveredSkill, signal?: AbortSignal): SkillInstruction | Promise<SkillInstruction>;
}

export type SkillActivation =
  | { allowed: true; skill: SkillInstruction }
  | { allowed: false; reason: string };

export function createSessionSkills(ports: SessionSkillsPorts) {
  // Only an I/O-in-flight guard, not a scheduler or authority lease. The
  // caller serializes ordinary controls; clear can retire an unfinished load.
  let pending:
    | { name: string; state: ReturnType<SessionSkillsPorts['state']>; sessionId?: string }
    | undefined;
  return {
    async activate(name: string, signal?: AbortSignal): Promise<SkillActivation> {
      signal?.throwIfAborted();
      if (pending) return { allowed: false, reason: 'A skill activation is already loading.' };
      const state = ports.state();
      const request = { name, state, sessionId: state.sessionId };
      pending = request;
      const current = () => {
        signal?.throwIfAborted();
        return (
          pending === request && ports.state() === state && state.sessionId === request.sessionId
        );
      };
      const retired: SkillActivation = {
        allowed: false,
        reason: 'Skill activation no longer belongs to the current selection or session.',
      };
      try {
        const skills = await ports.discover(signal);
        if (!current()) return retired;
        const found = skills.find((candidate) => candidate.name === name);
        if (!found) return { allowed: false, reason: `Skill not found: ${name}` };
        const skill = { ...found };
        const gate = canActivateSkill(skill, ports.policy);
        if (!gate.allowed)
          return { allowed: false, reason: gate.reason || 'Skill blocked by policy' };
        const loaded = await ports.load({ ...skill }, signal);
        if (!current()) return retired;
        // A loader cannot substitute a different identity/path or promote the
        // discovered trust label across an asynchronous load.
        if (
          loaded.name !== skill.name ||
          loaded.path !== skill.path ||
          loaded.source !== skill.source ||
          loaded.trustLevel !== skill.trustLevel
        )
          return { allowed: false, reason: 'Loaded skill does not match the discovered skill.' };
        const freshGate = canActivateSkill(loaded, ports.policy);
        if (!freshGate.allowed)
          return { allowed: false, reason: freshGate.reason || 'Skill blocked by policy' };
        state.activeSkills = [
          ...state.activeSkills.filter((entry) => entry.path !== loaded.path),
          loaded,
        ];
        return { allowed: true, skill: loaded };
      } finally {
        if (pending === request) pending = undefined;
      }
    },
    /** Empty/absent name clears all, matching /skill-clear; returns removed count. */
    clear(name?: string): number {
      if (!name || pending?.name === name) pending = undefined;
      const state = ports.state();
      const before = state.activeSkills.length;
      state.activeSkills = name ? state.activeSkills.filter((skill) => skill.name !== name) : [];
      return before - state.activeSkills.length;
    },
  };
}
