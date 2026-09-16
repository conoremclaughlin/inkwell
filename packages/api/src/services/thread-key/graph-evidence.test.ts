import { describe, it, expect } from 'vitest';
import {
  classifyEvidence,
  groupNodeEvents,
  linkifyText,
  mediaTypeForPath,
  type EvidenceField,
  type GateEventInput,
} from './graph-evidence';

/**
 * The evidence objects here are the REAL rows from the pr:543 and pr:547
 * graph-run reviews (task_gate_events, production) — the viewer's first
 * job is rendering exactly these, unmigrated.
 */

const pr547PassEvidence = {
  ref: 'github:conoremclaughlin/inkwell#547@6d9881625f8e403be06ab4619de9be8685f2ed33',
  kind: 'review',
  checks: [
    'Unit Tests',
    'Integration DB Tests (Local Supabase)',
    'Integration Runtime Tests',
    'GitGuardian Security Checks',
  ],
  verdict: 'LGTM',
  mergeTree: '706f90993801aedf6feb5ce4ccae6d8b0a8f4251',
  screenshots: ['1440x1150', '1440x2600', '390x844', '390x2600'],
  artifactCommit: '6d9881625f8e403be06ab4619de9be8685f2ed33',
  codeReviewedAt: '42adfc76a9cd2bd139cd54e624a58d32d5dde372',
};

const pr543PassEvidence = {
  url: 'https://github.com/conoremclaughlin/inkwell/pull/543#issuecomment-5420799490',
  kind: 'github_review',
  headSha: '4868ac8619e64b215a981f37df6cd4c535186c19',
  verdict: 'LGTM',
  verification: {
    ci: 'DB/runtime green; unit red only because CI could not download rg/fd',
    liveApi: 'sessions 500/877; messages 100/669 with truncation metadata',
    responsive: '390x844 drawer, drill-in, back; no horizontal overflow at 390 or 1440',
    focusedTests: '10/10 passed',
    webTypecheck: 'passed',
  },
};

function fieldByLabel(fields: EvidenceField[], label: string): EvidenceField | undefined {
  return fields.find((field) => field.label === label);
}

describe('classifyEvidence', () => {
  it('renders the pr:547 verdict: SHAs as shas, checks as chips, dimension labels never as media', () => {
    const fields = classifyEvidence(pr547PassEvidence);

    expect(fieldByLabel(fields, 'merge tree')).toEqual({
      label: 'merge tree',
      kind: 'sha',
      sha: '706f90993801aedf6feb5ce4ccae6d8b0a8f4251',
    });
    expect(fieldByLabel(fields, 'artifact commit')?.kind).toBe('sha');
    expect(fieldByLabel(fields, 'code reviewed at')?.kind).toBe('sha');
    expect(fieldByLabel(fields, 'checks')).toEqual({
      label: 'checks',
      kind: 'chips',
      items: [
        'Unit Tests',
        'Integration DB Tests (Local Supabase)',
        'Integration Runtime Tests',
        'GitGuardian Security Checks',
      ],
    });
    // "1440x2600" is a caption, not a file — it must never become a media
    // request against the file endpoint.
    expect(fieldByLabel(fields, 'screenshots')).toEqual({
      label: 'screenshots',
      kind: 'chips',
      items: ['1440x1150', '1440x2600', '390x844', '390x2600'],
    });
    expect(fieldByLabel(fields, 'verdict')).toEqual({
      label: 'verdict',
      kind: 'text',
      text: 'LGTM',
    });
  });

  it('renders the pr:543 verdict: url as link, nested verification object as a labeled group', () => {
    const fields = classifyEvidence(pr543PassEvidence);

    expect(fieldByLabel(fields, 'url')).toMatchObject({ kind: 'link' });
    const verificationGroup = fieldByLabel(fields, 'verification');
    expect(verificationGroup?.kind).toBe('group');
    if (verificationGroup?.kind === 'group') {
      expect(fieldByLabel(verificationGroup.fields, 'focused tests')).toEqual({
        label: 'focused tests',
        kind: 'text',
        text: '10/10 passed',
      });
      expect(verificationGroup.fields).toHaveLength(5);
    }
  });

  it('renders committed screenshot paths and shared-media paths as inline media', () => {
    const fields = classifyEvidence({
      shots: [
        'docs/screenshots/pr-547/threads-547-above-fold.jpeg',
        '~/.ink/files/wren-screenshots/threads-547-mobile.jpeg',
      ],
      demo: '~/.ink/files/wren-screenshots/walkthrough.mp4',
    });

    expect(fields).toEqual([
      {
        label: 'shots 1',
        kind: 'media',
        path: 'docs/screenshots/pr-547/threads-547-above-fold.jpeg',
        mediaType: 'image',
      },
      {
        label: 'shots 2',
        kind: 'media',
        path: '~/.ink/files/wren-screenshots/threads-547-mobile.jpeg',
        mediaType: 'image',
      },
      {
        label: 'demo',
        kind: 'media',
        path: '~/.ink/files/wren-screenshots/walkthrough.mp4',
        mediaType: 'video',
      },
    ]);
  });

  it('arrays of flat objects (typed checks) become readable chips', () => {
    const fields = classifyEvidence({
      checks: [
        { name: 'unit', status: 'success' },
        { name: 'integration', status: 'success' },
      ],
    });
    expect(fields).toEqual([
      { label: 'checks', kind: 'chips', items: ['unit · success', 'integration · success'] },
    ]);
  });

  it('never white-screens on shape: null, strings, and deep nesting all render', () => {
    expect(classifyEvidence(null)).toEqual([]);
    expect(classifyEvidence('just a note')).toEqual([
      { label: 'evidence', kind: 'text', text: 'just a note' },
    ]);
    const deep = classifyEvidence({ outer: { inner: { tooDeep: true } } });
    const outerGroup = fieldByLabel(deep, 'outer');
    expect(outerGroup?.kind).toBe('group');
    if (outerGroup?.kind === 'group') {
      expect(outerGroup.fields[0].kind).toBe('json');
    }
  });
});

describe('mediaTypeForPath', () => {
  it('requires both a path shape and a known extension', () => {
    expect(mediaTypeForPath('docs/screenshots/a.jpeg')).toBe('image');
    expect(mediaTypeForPath('~/.ink/files/x.mp4')).toBe('video');
    expect(mediaTypeForPath('/abs/report.pdf')).toBe('pdf');
    expect(mediaTypeForPath('1440x2600')).toBeNull();
    expect(mediaTypeForPath('screenshot.jpeg')).toBeNull(); // bare filename: no separator
    expect(mediaTypeForPath('docs/notes.txt')).toBeNull();
  });
});

describe('linkifyText', () => {
  it('splits a real gate failure reason into text and live links', () => {
    // Verbatim reason text from the pr:543 attempt-1 failure row.
    const reason =
      'Changes requested at head 88b0dbd9: capped thread rows can misclassify/reparse a real pinned thread. GitHub review: https://github.com/conoremclaughlin/inkwell/pull/543#issuecomment-5420676472';
    const parts = linkifyText(reason);
    expect(parts).toHaveLength(2);
    expect(parts[0].kind).toBe('text');
    expect(parts[1]).toEqual({
      kind: 'link',
      text: 'https://github.com/conoremclaughlin/inkwell/pull/543#issuecomment-5420676472',
      href: 'https://github.com/conoremclaughlin/inkwell/pull/543#issuecomment-5420676472',
    });
  });

  it('handles link-free text and mid-sentence links', () => {
    expect(linkifyText('no links here')).toEqual([{ kind: 'text', text: 'no links here' }]);
    const parts = linkifyText('see https://example.com/a and https://example.com/b too');
    expect(parts.map((part) => part.kind)).toEqual(['text', 'link', 'text', 'link', 'text']);
  });
});

describe('groupNodeEvents', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 7, 28, 21, minute)).toISOString();

  const event = (over: Partial<GateEventInput>): GateEventInput => ({
    event: 'opened',
    attempt: 1,
    gateVersion: 1,
    sessionId: null,
    actorAgentSlug: null,
    actorIsUser: false,
    evidence: null,
    reason: null,
    createdAt: at(0),
    ...over,
  });

  it('replays the pr:547 review gate: three attempts, verdicts on each, remediation opens the next', () => {
    // Shuffled input — grouping must not depend on ledger row order.
    const groups = groupNodeEvents([
      event({
        event: 'passed',
        attempt: 3,
        evidence: pr547PassEvidence,
        actorAgentSlug: 'lumen',
        createdAt: at(34),
      }),
      event({ event: 'opened', attempt: 1, createdAt: at(15) }),
      event({
        event: 'failed',
        attempt: 2,
        reason: 'artifacts incomplete',
        actorAgentSlug: 'lumen',
        createdAt: at(27),
      }),
      event({
        event: 'retry_requested',
        attempt: 2,
        reason: 'remediated at 42adfc76',
        actorAgentSlug: 'wren',
        createdAt: at(25),
      }),
      event({
        event: 'failed',
        attempt: 1,
        reason: 'changes requested',
        actorAgentSlug: 'lumen',
        createdAt: at(20),
      }),
      event({
        event: 'retry_requested',
        attempt: 3,
        reason: 'artifacts remediated at 6d988162',
        actorAgentSlug: 'wren',
        createdAt: at(30),
      }),
      event({ event: 'opened', attempt: 2, createdAt: at(25) }),
      event({ event: 'opened', attempt: 3, createdAt: at(30) }),
    ]);

    expect(groups.map((group) => group.attempt)).toEqual([1, 2, 3]);
    expect(groups.map((group) => group.verdict)).toEqual(['failed', 'failed', 'passed']);
    // The remediation note that OPENS attempt 2 lives in attempt 2's group.
    expect(groups[1].events[0].event).toBe('retry_requested');
    expect(groups[1].events[0].reasonParts[0].text).toContain('remediated at 42adfc76');
    // Evidence rides the passing event, classified.
    const passEvent = groups[2].events.find((entry) => entry.event === 'passed');
    expect(passEvent?.evidenceFields.some((field) => field.kind === 'sha')).toBe(true);
  });

  it('a work node claim/release lifecycle groups under its single attempt', () => {
    const groups = groupNodeEvents([
      event({ event: 'claim_released', attempt: 1, reason: 'cli-turn-stopped', createdAt: at(58) }),
      event({ event: 'claimed', attempt: 1, createdAt: at(56) }),
      event({ event: 'claimed', attempt: 1, createdAt: at(59) }),
      event({ event: 'claim_released', attempt: 1, reason: 'completed', createdAt: at(60) }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].verdict).toBeNull();
    expect(groups[0].events.map((entry) => entry.event)).toEqual([
      'claimed',
      'claim_released',
      'claimed',
      'claim_released',
    ]);
  });
});
