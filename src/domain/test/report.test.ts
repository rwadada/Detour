import { describe, expect, it } from 'vitest';
import { formatTestReport } from './report';

describe('formatTestReport', () => {
  it('renders a passing assertion with a checkmark and the matched count', () => {
    const output = formatTestReport([
      { name: 'requires auth', type: 'headerPresent', passed: true, matchedCount: 3, failures: [] },
    ]);
    expect(output).toContain('✔ requires auth (3 exchange(s) checked)');
    expect(output).toContain('1/1 assertion(s) passed');
  });

  it('renders a failing assertion with a cross and each failure indented below it', () => {
    const output = formatTestReport([
      {
        name: 'requires auth',
        type: 'headerPresent',
        passed: false,
        matchedCount: 1,
        failures: [{ exchangeId: 'ex-1', method: 'GET', url: 'https://x/orders', reason: 'missing header' }],
      },
    ]);
    expect(output).toContain('✖ requires auth (1 exchange(s) checked)');
    expect(output).toContain('missing header — GET https://x/orders');
    expect(output).toContain('0/1 assertion(s) passed');
  });

  it('notes when nothing matched instead of a checked count', () => {
    const output = formatTestReport([
      { name: 'x', type: 'headerPresent', passed: false, matchedCount: 0, failures: [] },
    ]);
    expect(output).toContain('✖ x (no exchanges matched)');
  });

  it('reports the computed p95 for a latencyP95 assertion', () => {
    const output = formatTestReport([
      { name: 'fast', type: 'latencyP95', passed: true, matchedCount: 5, p95Ms: 120, failures: [] },
    ]);
    expect(output).toContain('✔ fast (p95 120ms across 5 exchange(s))');
  });

  it('omits the location suffix for a failure with no associated exchange (e.g. latencyP95)', () => {
    const output = formatTestReport([
      {
        name: 'fast',
        type: 'latencyP95',
        passed: false,
        matchedCount: 5,
        p95Ms: 900,
        failures: [{ exchangeId: '', method: '', url: '', reason: 'p95 latency 900ms exceeds 500ms' }],
      },
    ]);
    expect(output).toContain('p95 latency 900ms exceeds 500ms\n');
    expect(output).not.toContain('p95 latency 900ms exceeds 500ms —');
  });
});
