/**
 * Shim for Claude Code's src/utils/semver.ts
 *
 * The rendering engine uses gte() for version-gated terminal features.
 * Claude Code's version wraps Bun.semver with npm semver fallback.
 * We use the semver package directly (already in our deps via transitive).
 */

import semver from 'semver';

export function gt(a: string, b: string): boolean {
  return semver.gt(a, b, { loose: true });
}

export function gte(a: string, b: string): boolean {
  return semver.gte(a, b, { loose: true });
}

export function lt(a: string, b: string): boolean {
  return semver.lt(a, b, { loose: true });
}

export function lte(a: string, b: string): boolean {
  return semver.lte(a, b, { loose: true });
}

export function satisfies(version: string, range: string): boolean {
  return semver.satisfies(version, range, { loose: true });
}

export function order(a: string, b: string): -1 | 0 | 1 {
  return semver.compare(a, b, { loose: true });
}
