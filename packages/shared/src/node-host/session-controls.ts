/** Boundary-only controls for one composer. This queue grants no ownership or permissions. */
import {
  MAX_SELECTED_SKILLS,
  parseSessionControl,
  readSessionControl,
  type SessionSelection,
  type SessionControlRecord,
  type SessionControlRequest,
  type SessionControlReceipt,
  type SessionLog,
  type SessionPromptSkill,
  type ToolPolicyState,
} from '../runtime/index.js';
import { applyModelSelection, type SessionModelState } from '../providers/session-model.js';
import type { SkillInstruction } from '../providers/skill-discovery.js';
import { createSessionSkills, type SessionSkillsPorts } from './session-skills.js';
import { canActivateSkill } from './skill-policy.js';
import { SkillInstructionDriftError } from './skill-instructions.js';

export interface SessionControlsPorts {
  runtime: Omit<SessionModelState, 'log'> & {
    sessionId?: string;
    activeSkills?: readonly SessionPromptSkill[];
    providerRecoveryDisabled?: boolean;
    appliedControlId?: string;
  };
  log: Pick<SessionLog, 'append' | 'flush'>;
  policy: ToolPolicyState;
  skills?: Pick<SessionSkillsPorts, 'discover' | 'load'>;
  contextBudgetAuto: boolean;
  assertCurrent(): void;
  invalidateProvider(): void;
  mintId(): string;
  receipt?(receipt: SessionControlReceipt): void;
  /** Static diagnostics only: never relay untrusted record bytes or filesystem errors. */
  notice?(message: string): void;
}
const reference = ({ content: _content, ...skill }: SkillInstruction) => skill;
const provenanceKey = (skill: { provenance?: object }) =>
  JSON.stringify(Object.entries(skill.provenance ?? {}).sort(([a], [b]) => a.localeCompare(b)));

export function createSessionControls(ports: SessionControlsPorts) {
  let selection: SessionSelection = { skills: [] };
  let manual: SkillInstruction[] = [];
  const baseline = [...(ports.runtime.activeSkills ?? [])];
  let recovered: SessionControlRecord | undefined;
  let skippedRecord = false;
  let open = true;
  let draining = false;
  let poisoned = false;
  const entries = new Map<
    string,
    { request: SessionControlRequest; receipt: SessionControlReceipt }
  >();
  const pending: string[] = [];
  function notice(message: string) {
    try {
      ports.notice?.(message);
    } catch {
      /* presentation cannot break replay */
    }
  }
  function ownerStopped(signal?: AbortSignal) {
    if (signal?.aborted) return true;
    try {
      ports.assertCurrent();
      return false;
    } catch {
      return true;
    }
  }
  function current(signal?: AbortSignal) {
    signal?.throwIfAborted();
    ports.assertCurrent();
    if (poisoned) throw new Error('Session control persistence is uncertain');
  }
  function install(next: SessionSelection, skills: SkillInstruction[], controlId: string) {
    selection = next;
    ports.runtime.appliedControlId = controlId;
    manual = skills;
    ports.runtime.providerRecoveryDisabled = skills.length !== next.skills.length;
    // Compute with the shared selector, but only assign after the durable barrier.
    if ('model' in next) {
      const draft = { ...ports.runtime, log: { append: () => 0 } };
      applyModelSelection(draft, next.model ?? undefined, ports.contextBudgetAuto);
      Object.assign(ports.runtime, {
        model: draft.model,
        detectedModel: draft.detectedModel,
        backendTokenWindow: draft.backendTokenWindow,
        maxContextTokens: draft.maxContextTokens,
      });
    }
    ports.runtime.activeSkills = [...baseline, ...skills];
  }
  async function commit(
    id: string,
    next: SessionSelection,
    skills: SkillInstruction[],
    signal?: AbortSignal,
    reason?: SessionControlRecord['reason']
  ) {
    current(signal);
    const record = readSessionControl({
      type: 'session_control',
      version: 1,
      controlId: id,
      backend: ports.runtime.backend,
      selection: next,
      ...(reason ? { reason } : {}),
    });
    let eid: number;
    try {
      eid = ports.log.append(record);
      await ports.log.flush();
      current(signal);
      if (next.skills.some((skill) => !canActivateSkill(skill, ports.policy).allowed))
        throw new Error('Skill policy changed during persistence');
    } catch (error) {
      // A failed/timed-out flush may still have written the record. Never retry
      // or launch against guessed state; replay from a closed writer adjudicates it.
      poisoned = true;
      throw error;
    }
    install(record.selection, skills, record.controlId);
    ports.invalidateProvider(); // even no-op settings must establish a fresh native baseline
    return eid;
  }
  function publish(id: string, receipt: SessionControlReceipt) {
    const entry = entries.get(id);
    if (entry) entry.receipt = receipt;
    try {
      ports.receipt?.({ ...receipt });
    } catch {
      /* presentation cannot change the outcome */
    }
  }
  return {
    /** Persisted model choice, distinct from an inherited launch default. */
    get selectedModel(): string | null | undefined {
      return selection.model;
    },
    replay(event: Record<string, unknown>) {
      if (event.type !== 'session_control') return;
      try {
        recovered = readSessionControl(event);
      } catch {
        skippedRecord = true;
        notice('Skipped an invalid or unsupported session control record.');
      }
    },
    async restore(signal?: AbortSignal, providerControlId?: string) {
      current(signal);
      // A later native marker could have been seeded under an unfamiliar record.
      // Keep the last known selection, but never resume that opaque baseline.
      if (!recovered) {
        if (skippedRecord) ports.invalidateProvider();
        return;
      }
      const backendChanged = recovered.backend !== ports.runtime.backend;
      const loaded: SkillInstruction[] = [];
      const retained: SessionSelection['skills'] = [];
      for (const expected of recovered.selection.skills) {
        current(signal);
        if (!canActivateSkill(expected, ports.policy).allowed) continue;
        if (!ports.skills) {
          retained.push(expected);
          notice('A selected skill is unavailable on this host; retaining its selection.');
          continue;
        }
        try {
          const skill = await ports.skills.load(expected, signal);
          current(signal);
          if (
            skill.name === expected.name &&
            skill.path === expected.path &&
            skill.source === expected.source &&
            skill.trustLevel === expected.trustLevel &&
            skill.contentDigest === expected.contentDigest &&
            provenanceKey(skill) === provenanceKey(expected) &&
            canActivateSkill(skill, ports.policy).allowed
          ) {
            loaded.push(skill);
            retained.push(expected);
          }
        } catch (error) {
          current(signal); // cancellation/lost ownership is not evidence to drop a skill
          const absent =
            !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
          if (absent || error instanceof SkillInstructionDriftError) continue;
          retained.push(expected);
          notice('A selected skill could not be loaded for this run; retaining its selection.');
        }
      }
      current(signal);
      const skills = retained.filter((skill) => canActivateSkill(skill, ports.policy).allowed);
      const allowed = loaded.filter((skill) => canActivateSkill(skill, ports.policy).allowed);
      // Desired references and this run's instructions differ on transient I/O.
      // Future controls must preserve those references until explicitly cleared.
      const next: SessionSelection = backendChanged
        ? { skills } // old provider's model cannot override the new launch configuration
        : { ...recovered.selection, skills };
      if (backendChanged || skills.length !== recovered.selection.skills.length)
        await commit(
          ports.mintId(),
          next,
          allowed,
          signal,
          backendChanged ? 'replay_backend_changed' : 'replay_skill_removed'
        );
      else {
        install(next, allowed, recovered.controlId);
        // Omitting unavailable instructions requires a fresh provider envelope too.
        if (
          skippedRecord ||
          providerControlId !== recovered.controlId ||
          allowed.length !== skills.length
        )
          ports.invalidateProvider();
      }
    },
    enqueue(value: SessionControlRequest): SessionControlReceipt {
      const request = parseSessionControl(value);
      const refused = (reason: string): SessionControlReceipt => ({
        controlId: value.controlId,
        status: 'refused',
        reason,
      });
      if (!request) return refused('invalid_control');
      try {
        current();
      } catch {
        return refused('owner_unavailable');
      }
      if (!open) return refused('owner_closing');
      const prior = entries.get(request.controlId);
      if (prior)
        return JSON.stringify(prior.request) === JSON.stringify(request)
          ? { ...prior.receipt }
          : refused('control_id_conflict');
      // Bound receipts AND pending work; do not evict dedupe evidence while the owner lives.
      if (entries.size >= 128) return refused('control_capacity');
      const receipt: SessionControlReceipt = { controlId: request.controlId, status: 'pending' };
      entries.set(request.controlId, { request, receipt });
      pending.push(request.controlId);
      return { ...receipt };
    },
    close() {
      open = false;
    },
    refusePending(reason: string) {
      open = false;
      for (const id of pending.splice(0)) publish(id, { controlId: id, status: 'refused', reason });
    },
    async drain(signal?: AbortSignal) {
      if (draining) throw new Error('Session controls already draining');
      draining = true;
      try {
        current(signal);
        for (const id of pending.splice(0)) {
          const entry = entries.get(id)!;
          const draft = { sessionId: ports.runtime.sessionId, activeSkills: [...manual] };
          const next = { ...selection, skills: [...selection.skills] };
          let attemptingCommit = false;
          try {
            current(signal);
            const request = entry.request;
            if (request.action === 'model') next.model = request.model;
            else if (request.action === 'skill_clear') {
              draft.activeSkills = request.name
                ? draft.activeSkills.filter((s) => s.name !== request.name)
                : [];
              next.skills = request.name ? next.skills.filter((s) => s.name !== request.name) : [];
            } else {
              if (!ports.skills) throw new Error('Manual skills are unavailable on this host');
              const activation = await createSessionSkills({
                state: () => draft,
                policy: ports.policy,
                ...ports.skills,
              }).activate(request.name, signal);
              if (!activation.allowed) throw new Error(activation.reason);
              next.skills = [
                ...next.skills.filter((s) => s.path !== activation.skill.path),
                reference(activation.skill) as SessionSelection['skills'][number],
              ];
              if (next.skills.length > MAX_SELECTED_SKILLS)
                throw new Error('Too many active skills');
            }
            current(signal);
            if (next.skills.some((s) => !canActivateSkill(s, ports.policy).allowed))
              throw new Error('Skill policy changed');
            attemptingCommit = true;
            const eid = await commit(id, next, draft.activeSkills, signal);
            publish(id, { controlId: id, status: 'applied', eid });
          } catch {
            publish(id, {
              controlId: id,
              status: attemptingCommit && poisoned ? 'unknown' : 'refused',
              reason:
                attemptingCommit && poisoned
                  ? 'persistence_or_owner_uncertain'
                  : ownerStopped(signal)
                    ? 'owner_stopped'
                    : 'control_not_allowed',
            });
          }
        }
        current(signal); // a poisoned/cancelled owner cannot launch another turn
      } finally {
        draining = false;
      }
    },
  };
}
