export type ToolGroupMap = Record<string, string[]>;

export function normalizePolicyToken(value: string): string {
  return value.trim().toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function compilePolicyPattern(pattern: string): RegExp | null {
  const normalized = normalizePolicyToken(pattern);
  if (!normalized) return null;
  if (normalized === '*') return /^.*$/i;
  if (!normalized.includes('*')) return new RegExp(`^${escapeRegex(normalized)}$`, 'i');
  return new RegExp(`^${escapeRegex(normalized).replaceAll('*', '.*')}$`, 'i');
}

export function matchesPolicyPattern(value: string, pattern: string): boolean {
  const compiled = compilePolicyPattern(pattern);
  if (!compiled) return false;
  return compiled.test(normalizePolicyToken(value));
}

export function matchesAnyPolicyPattern(value: string, patterns: Iterable<string>): boolean {
  const normalized = normalizePolicyToken(value);
  for (const pattern of patterns) {
    if (matchesPolicyPattern(normalized, pattern)) {
      return true;
    }
  }
  return false;
}

export function expandPolicySpecs(specs: string[], groups: ToolGroupMap): string[] {
  const expanded: string[] = [];
  for (const spec of specs) {
    const normalized = normalizePolicyToken(spec);
    if (!normalized) continue;
    const groupMembers = groups[normalized];
    if (groupMembers && groupMembers.length > 0) {
      for (const member of groupMembers) {
        const normalizedMember = normalizePolicyToken(member);
        if (normalizedMember) expanded.push(normalizedMember);
      }
    } else {
      expanded.push(normalized);
    }
  }
  return Array.from(new Set(expanded));
}
