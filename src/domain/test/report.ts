import type { AssertionResult } from './evaluate';

function formatDetail(result: AssertionResult): string {
  if (result.matchedCount === 0) return ' (no exchanges matched)';
  if (result.type === 'latencyP95' && result.p95Ms !== undefined) {
    return ` (p95 ${result.p95Ms}ms across ${result.matchedCount} exchange(s))`;
  }
  return ` (${result.matchedCount} exchange(s) checked)`;
}

/** Human-readable summary of a `detour test` run, for `console.log`/`console.error`. Kept pure (no I/O) so it's unit-testable without spawning the CLI. */
export function formatTestReport(results: AssertionResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const icon = result.passed ? '✔' : '✖';
    lines.push(`${icon} ${result.name}${formatDetail(result)}`);
    for (const failure of result.failures) {
      const location = failure.url ? ` — ${failure.method} ${failure.url}` : '';
      lines.push(`    ${failure.reason}${location}`);
    }
  }
  const passedCount = results.filter((r) => r.passed).length;
  // Only separates the summary from actual per-assertion output above it —
  // with zero assertions, `lines` is still empty here, and an unconditional
  // blank line would make the whole report start with one for no reason.
  if (lines.length > 0) lines.push('');
  lines.push(`${passedCount}/${results.length} assertion(s) passed`);
  return lines.join('\n');
}
