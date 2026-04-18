/**
 * Markdown report writer for scenario runs.
 */

import type { ScenarioResult } from './types.js';

export interface ReportOptions {
  title?: string;
  runAt?: Date;
  serverUrl?: string;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function verdict(passed: boolean): string {
  return passed ? '✅ PASS' : '❌ FAIL';
}

export function writeMarkdownReport(results: ScenarioResult[], opts: ReportOptions = {}): string {
  const title = opts.title ?? 'Memory Real-Scenario Eval Report';
  const runAt = (opts.runAt ?? new Date()).toISOString();
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`**Run at:** ${runAt}`);
  if (opts.serverUrl) lines.push(`**Server:** ${opts.serverUrl}`);
  lines.push('');

  // Summary
  const passed = results.filter((r) => r.passed).length;
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`- Scenarios: ${results.length}`);
  lines.push(`- Passed: ${passed} / ${results.length}`);

  if (results.length > 0) {
    const avgP = results.reduce((s, r) => s + r.metrics.precision, 0) / results.length;
    const avgR = results.reduce((s, r) => s + r.metrics.recall, 0) / results.length;
    lines.push(`- Avg precision: ${pct(avgP)}`);
    lines.push(`- Avg recall: ${pct(avgR)}`);
  }
  lines.push('');

  // Per-scenario
  lines.push('## Per-scenario results');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.scenarioId} ${verdict(r.passed)}`);
    lines.push('');
    lines.push(`- shape: \`${r.shape}\``);
    lines.push(
      `- topic signal: \`${r.topicSignal.slice(0, 80)}${r.topicSignal.length > 80 ? '…' : ''}\``
    );
    lines.push(`- surfaced: ${r.surfacedCount} items`);
    lines.push(
      `- precision: ${pct(r.metrics.precision)} · recall: ${pct(r.metrics.recall)}` +
        (r.metrics.mustAssertPassRate !== undefined
          ? ` · must-assert: ${pct(r.metrics.mustAssertPassRate)}`
          : '') +
        (r.metrics.mustNotAssertLeakRate !== undefined
          ? ` · leaks: ${pct(r.metrics.mustNotAssertLeakRate)}`
          : '')
    );

    if (r.mustAssertVerdicts && r.mustAssertVerdicts.length > 0) {
      lines.push('');
      lines.push('**Must-assert claims:**');
      for (const v of r.mustAssertVerdicts) {
        lines.push(`- ${v.passed ? '✓' : '✗'} (${v.criticality}) ${v.claim}`);
      }
    }

    if (r.mustNotAssertVerdicts && r.mustNotAssertVerdicts.length > 0) {
      const leaks = r.mustNotAssertVerdicts.filter((v) => v.leaked);
      if (leaks.length > 0) {
        lines.push('');
        lines.push('**Must-not-assert leaks:**');
        for (const v of leaks) lines.push(`- ⚠ ${v.claim}`);
      }
    }

    if (r.surfaced.length > 0) {
      lines.push('');
      lines.push('**Surfaced items:**');
      for (const s of r.surfaced.slice(0, 10)) {
        const tag = s.matchedExpectedRef ? `→ ${s.matchedExpectedRef}` : '(unmatched)';
        lines.push(`- \`${s.id.slice(0, 8)}\` ${tag} — ${s.contentPreview}`);
      }
    }

    if (r.failureReasons.length > 0) {
      lines.push('');
      lines.push('**Failure reasons:**');
      for (const f of r.failureReasons) lines.push(`- ${f}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
