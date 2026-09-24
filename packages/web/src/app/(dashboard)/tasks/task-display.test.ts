/**
 * The tasks page crashed with "Cannot read properties of undefined (reading
 * 'bgColor')" because `priorityConfig[priority]` was indexed directly and the
 * database held a priority the map has no key for.
 *
 * So these tests are written against the OPEN domain, not the declared union.
 * `tasks.priority` and `tasks.status` are unconstrained varchars; the union in
 * page.tsx is an intention, and the crash was the gap between the two. The
 * cases below include the values from the second priority vocabulary this
 * codebase uses elsewhere (`low|normal|high|urgent` — inbox messages, triggers
 * and task groups, whose column default is 'normal'), because that is where the
 * two rows that took the page down actually came from.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolvePriority,
  resolveStatus,
  priorityConfig,
  statusConfig,
  DEFAULT_PRIORITY,
} from './task-display';

/** Exactly the fields PriorityBadge reads. Reading any of these is what threw. */
const PRIORITY_FIELDS = ['label', 'color', 'bgColor', 'borderColor', 'dotColor'] as const;
/** Exactly the fields StatusDot / TaskCard / TaskColumn read. */
const STATUS_FIELDS = [
  'label',
  'color',
  'bgColor',
  'borderColor',
  'accentColor',
  'dotColor',
] as const;

describe('resolvePriority', () => {
  it('renders every priority the tasks vocabulary defines', () => {
    for (const key of Object.keys(priorityConfig)) {
      if (key === DEFAULT_PRIORITY) continue;
      const style = resolvePriority(key);
      expect(style, key).not.toBeNull();
      expect(style!.label).toBe(priorityConfig[key].label);
    }
  });

  it('survives the OTHER priority vocabulary — this is the reported crash', () => {
    // 'normal' is the task_groups column default and sits on two task rows
    // written 2026-05-13; 'urgent' is its high end. Neither is a tasks value.
    for (const foreign of ['normal', 'urgent']) {
      const style = resolvePriority(foreign);
      expect(style, foreign).not.toBeNull();
      for (const field of PRIORITY_FIELDS) {
        expect(typeof style![field], `${foreign}.${field}`).toBe('string');
        expect(style![field].length, `${foreign}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('shows the raw value rather than relabelling it as something known', () => {
    // Quietly rendering 'normal' as "Medium" would be a readable page telling
    // the reader something the row does not say.
    const style = resolvePriority('normal');
    expect(style!.label).toBe('normal');
    expect(Object.values(priorityConfig).map((c) => c.label)).not.toContain(style!.label);
  });

  it('draws no badge for the default or for a missing value', () => {
    // A task with no priority gets the column default, which is medium — and
    // badging what everything has says nothing.
    expect(resolvePriority(DEFAULT_PRIORITY)).toBeNull();
    expect(resolvePriority(null)).toBeNull();
    expect(resolvePriority(undefined)).toBeNull();
    expect(resolvePriority('')).toBeNull();
  });

  it('does not hand back an inherited member for a prototype-named value', () => {
    // priorityConfig['constructor'] returns Object.prototype.constructor — a
    // function, so `?? fallback` never fires and the caller reads .bgColor off
    // it. Same crash, through the one door the fallback does not cover.
    for (const value of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const style = resolvePriority(value);
      expect(style, value).not.toBeNull();
      expect(style!.label, value).toBe(value);
      for (const field of PRIORITY_FIELDS) {
        expect(typeof style![field], `${value}.${field}`).toBe('string');
      }
    }
  });

  it('clamps a value long enough to wreck the layout', () => {
    const style = resolvePriority('x'.repeat(500));
    expect(style!.label.length).toBeLessThanOrEqual(25);
    expect(style!.label.endsWith('…')).toBe(true);
  });
});

describe('resolveStatus', () => {
  it('renders every status the tasks vocabulary defines', () => {
    for (const key of Object.keys(statusConfig)) {
      const style = resolveStatus(key);
      expect(style.label).toBe(statusConfig[key].label);
      expect(style.icon).toBe(statusConfig[key].icon);
    }
  });

  it('returns a usable style — icon included — for a status it does not know', () => {
    // TaskCard does `const StatusIcon = config.icon`, so a missing icon is a
    // render crash of the same shape as the priority one.
    for (const unknown of ['cancelled', 'archived', 'deferred', '']) {
      const style = resolveStatus(unknown);
      expect(style.icon, unknown).toBeTruthy();
      for (const field of STATUS_FIELDS) {
        expect(typeof style[field], `${unknown}.${field}`).toBe('string');
        expect(style[field].length, `${unknown}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('does not hand back an inherited member for a prototype-named status', () => {
    for (const value of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const style = resolveStatus(value);
      expect(style.icon, value).toBeTruthy();
      expect(style.label, value).toBe(value);
      for (const field of STATUS_FIELDS) {
        expect(typeof style[field], `${value}.${field}`).toBe('string');
      }
    }
  });

  it('handles a null status', () => {
    expect(resolveStatus(null).label).toBe('Unknown');
    expect(resolveStatus(undefined).icon).toBeTruthy();
  });
});

describe('page.tsx goes through the resolvers', () => {
  // Without this, the resolvers can stay green while the page quietly
  // reintroduces a direct lookup — which is exactly the line that crashed.
  const source = readFileSync(join(__dirname, 'page.tsx'), 'utf-8');

  it('never indexes a style map directly', () => {
    const bare = source
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /\b(priorityConfig|statusConfig)\s*\[/.test(line));
    expect(bare.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([]);
  });

  it('calls both resolvers', () => {
    expect(source).toMatch(/resolvePriority\s*\(/);
    expect(source).toMatch(/resolveStatus\s*\(/);
  });
});
