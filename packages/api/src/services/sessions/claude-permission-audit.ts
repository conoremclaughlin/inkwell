/**
 * Pure, advisory comparison of Claude permission configuration, not execution
 * authorization or proof that a tool call will run without a prompt. The caller
 * owns source loading/validation and warning delivery. No settings are changed.
 *
 * Only known coverage relationships are inferred. In particular, MCP wildcards
 * are server-scoped, not globs across server names. File rules retain their path
 * spelling: their anchors depend on the source and execution directory (see
 * shared/studio/claude-defaults and launch-settings). Without those roots we
 * cannot equate them, resolve paths, or infer containment
 * between different path patterns. Arbitrary command/glob containment is also
 * deliberately not inferred. Empty findings never mean "effective permissions
 * are good": runtime policy, hooks, sandboxing and unmodelled rules still apply.
 */

export interface ClaudePermissionRuleLists {
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
}

export interface ClaudePermissionShadow {
  /** Original standard allow rule, not a normalized replacement. */
  expectedRule: string;
  /** Original observed ask/deny rule. */
  rule: string;
  /** Whether the restriction covers all or a known subset of the expected rule. */
  overlap: 'full' | 'partial';
}

export interface ClaudePermissionCoverage {
  /** No observed allow is known to cover this rule; not a claim of denial. */
  missingAllow: string[];
  /** Kept separate from missing allows and denies, even when a deny also matches. */
  shadowingAsk: ClaudePermissionShadow[];
  shadowingDeny: ClaudePermissionShadow[];
}

type ParsedRule =
  | { kind: 'mcp'; server: string; tool?: string }
  | { kind: 'builtin'; tool: string; pattern?: string };

/** Only these argument patterns are treated as unrestricted, never file globs. */
const UNRESTRICTED_PATTERN_TOOLS = new Set(['Bash', 'WebFetch', 'WebSearch']);

function parseRule(rule: string): ParsedRule | undefined {
  if (rule.startsWith('mcp__')) {
    const name = rule.slice('mcp__'.length);
    const separator = name.indexOf('__');
    const server = separator === -1 ? name : name.slice(0, separator);
    const tool = separator === -1 ? undefined : name.slice(separator + 2);
    const isName = (value: string) => value.length > 0 && !/[^A-Za-z0-9_.-]/.test(value);
    // A cross-server `mcp__*` or partial tool glob is not a known grant, even
    // when the expected string is identical. Never fall back to generic globs.
    if (!isName(server) || (tool !== undefined && tool !== '*' && !isName(tool))) {
      return undefined;
    }
    return { kind: 'mcp', server, tool: tool === '*' ? undefined : tool };
  }

  const match = rule.match(/^([A-Za-z][A-Za-z0-9_]*)(?:\((.+)\))?$/s);
  // Do not repair malformed rules (including surrounding whitespace) into grants.
  if (!match || match[0] !== rule) return undefined;
  return { kind: 'builtin', tool: match[1], pattern: match[2] };
}

function isUnrestricted(rule: Extract<ParsedRule, { kind: 'builtin' }>): boolean {
  return (
    rule.pattern === undefined ||
    (rule.pattern === '*' && UNRESTRICTED_PATTERN_TOOLS.has(rule.tool))
  );
}

function covers(candidate: ParsedRule, expected: ParsedRule): boolean {
  if (candidate.kind === 'mcp' && expected.kind === 'mcp') {
    return (
      candidate.server === expected.server &&
      (candidate.tool === undefined || candidate.tool === expected.tool)
    );
  }
  if (candidate.kind === 'builtin' && expected.kind === 'builtin') {
    return (
      candidate.tool === expected.tool &&
      (isUnrestricted(candidate) || candidate.pattern === expected.pattern)
    );
  }
  return false;
}

function shadowOverlap(
  expected: ParsedRule,
  restriction: ParsedRule,
  effect: 'ask' | 'deny'
): ClaudePermissionShadow['overlap'] | undefined {
  if (covers(restriction, expected)) return 'full';
  if (!covers(expected, restriction)) return undefined;

  // A narrower Bash deny beside blanket Bash is expected policy, not a missing
  // blanket grant. Do not nag an operator to remove a destructive-command
  // backstop. Scoped expected Bash rules still report an exact/full shadow;
  // narrow asks still warrant notice because they can introduce prompts.
  if (
    effect === 'deny' &&
    expected.kind === 'builtin' &&
    expected.tool === 'Bash' &&
    isUnrestricted(expected)
  ) {
    return undefined;
  }
  return 'partial';
}

/**
 * Compare validated, already-selected configuration lists. `missingAllow` is
 * independent of ask/deny: an allow may be present AND shadowed. MCP exact-tool
 * restrictions are reported when a whole namespace is expected, even if its
 * allow is missing. Both ask and deny findings are retained for diagnosis, not
 * collapsed into a simulated execution decision.
 *
 * Exact duplicate strings are collapsed in first-seen order. Unsupported or
 * malformed expected rules remain missing rather than implying known coverage.
 * No input is mutated. This function intentionally has no IO or provider calls.
 */
export function analyzeClaudePermissionCoverage(
  expectedAllow: readonly string[],
  observed: ClaudePermissionRuleLists
): ClaudePermissionCoverage {
  const result: ClaudePermissionCoverage = {
    missingAllow: [],
    shadowingAsk: [],
    shadowingDeny: [],
  };
  const allow = [...new Set(observed.allow)].map(parseRule);
  const ask = [...new Set(observed.ask)].map((rule) => ({ rule, parsed: parseRule(rule) }));
  const deny = [...new Set(observed.deny)].map((rule) => ({ rule, parsed: parseRule(rule) }));

  for (const expectedRule of new Set(expectedAllow)) {
    const expected = parseRule(expectedRule);
    if (!expected || !allow.some((rule) => rule && covers(rule, expected))) {
      result.missingAllow.push(expectedRule);
    }
    if (!expected) continue;

    for (const [effect, rules, findings] of [
      ['ask', ask, result.shadowingAsk],
      ['deny', deny, result.shadowingDeny],
    ] as const) {
      for (const { rule, parsed } of rules) {
        if (!parsed) continue;
        const overlap = shadowOverlap(expected, parsed, effect);
        if (overlap) findings.push({ expectedRule, rule, overlap });
      }
    }
  }
  return result;
}
