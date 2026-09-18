import type { CapturedExchange } from '../exchange/types';
import { flattenHeaders } from '../exchange/headers';
import { compileGlob, normalizeMethods } from '../rules/matcher';
import { PII_PATTERNS } from './piiPatterns';
import type { TestAssertion, TestMatch } from './types';

interface MatchableExchange {
  method: string;
  url: string;
}

function compileMatch(match: TestMatch): (exchange: MatchableExchange) => boolean {
  const methods = normalizeMethods(match.method);
  const urlTest =
    match.urlRegex !== undefined ? new RegExp(match.urlRegex, match.urlRegexFlags) : compileGlob(match.url ?? '*');
  return (exchange) => {
    if (methods && !methods.includes(exchange.method.toUpperCase())) return false;
    return urlTest.test(exchange.url);
  };
}

/** One concrete violation an assertion found — enough to locate the offending exchange without a caller having to re-derive it. */
export interface AssertionFailureDetail {
  exchangeId: string;
  method: string;
  url: string;
  reason: string;
}

export interface AssertionResult {
  name: string;
  type: TestAssertion['type'];
  passed: boolean;
  /** How many captured exchanges this assertion's `match` selected — 0 alongside `passed: false` almost always means a typo'd `match`. */
  matchedCount: number;
  failures: AssertionFailureDetail[];
  /** Set only for `latencyP95`, even when it passed — useful to report regardless of outcome. */
  p95Ms?: number;
}

function toFailureDetail(exchange: CapturedExchange, reason: string): AssertionFailureDetail {
  return { exchangeId: exchange.id, method: exchange.method, url: exchange.url, reason };
}

function evaluateHeaderPresent(
  assertion: Extract<TestAssertion, { type: 'headerPresent' }>,
  matched: CapturedExchange[],
): AssertionResult {
  const phase = assertion.phase ?? 'request';
  const failures: AssertionFailureDetail[] = [];
  if (matched.length === 0 && !assertion.allowNoMatches) {
    return { name: assertion.name, type: assertion.type, passed: false, matchedCount: 0, failures: [] };
  }
  for (const exchange of matched) {
    const headers = phase === 'response' ? exchange.responseHeaders : exchange.requestHeaders;
    const value = headers ? headers[assertion.header.toLowerCase()] : undefined;
    if (value === undefined) {
      failures.push(
        toFailureDetail(
          exchange,
          headers === undefined
            ? `no ${phase} was captured for this exchange`
            : `missing "${assertion.header}" ${phase} header`,
        ),
      );
    }
  }
  return {
    name: assertion.name,
    type: assertion.type,
    passed: failures.length === 0,
    matchedCount: matched.length,
    failures,
  };
}

function evaluateLatencyP95(
  assertion: Extract<TestAssertion, { type: 'latencyP95' }>,
  matched: CapturedExchange[],
): AssertionResult {
  if (matched.length === 0 && !assertion.allowNoMatches) {
    return { name: assertion.name, type: assertion.type, passed: false, matchedCount: 0, failures: [] };
  }
  const durations = matched.map((e) => e.durationMs).filter((ms): ms is number => ms !== undefined);
  if (durations.length === 0) {
    return { name: assertion.name, type: assertion.type, passed: true, matchedCount: matched.length, failures: [] };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  // Nearest-rank method: the smallest value at or above the 95th percentile.
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  const p95Ms = sorted[index]!;
  const passed = p95Ms <= assertion.maxMs;
  return {
    name: assertion.name,
    type: assertion.type,
    passed,
    matchedCount: matched.length,
    p95Ms,
    failures: passed
      ? []
      : [
          {
            exchangeId: '',
            method: '',
            url: '',
            reason: `p95 latency ${p95Ms}ms exceeds ${assertion.maxMs}ms across ${durations.length} matching exchange(s)`,
          },
        ],
  };
}

function findPiiLabel(text: string, assertion: Extract<TestAssertion, { type: 'noPiiLeak' }>): string | undefined {
  for (const name of assertion.patterns ?? []) {
    if (PII_PATTERNS[name].test(text)) return name;
  }
  for (const source of assertion.customPatterns ?? []) {
    if (new RegExp(source, 'i').test(text)) return `custom pattern /${source}/`;
  }
  return undefined;
}

function evaluateNoPiiLeak(
  assertion: Extract<TestAssertion, { type: 'noPiiLeak' }>,
  matched: CapturedExchange[],
): AssertionResult {
  const failures: AssertionFailureDetail[] = [];
  for (const exchange of matched) {
    const fields: Array<{ field: string; text: string }> = [];
    for (const [key, value] of Object.entries(flattenHeaders(exchange.requestHeaders))) {
      fields.push({ field: `request header "${key}"`, text: value });
    }
    if (exchange.requestBody) {
      fields.push({ field: 'request body', text: Buffer.from(exchange.requestBody, 'base64').toString('utf8') });
    }
    if (exchange.responseHeaders) {
      for (const [key, value] of Object.entries(flattenHeaders(exchange.responseHeaders))) {
        fields.push({ field: `response header "${key}"`, text: value });
      }
    }
    if (exchange.responseBody) {
      fields.push({ field: 'response body', text: Buffer.from(exchange.responseBody, 'base64').toString('utf8') });
    }
    for (const { field, text } of fields) {
      const label = findPiiLabel(text, assertion);
      // The matched value itself is never included in the failure reason —
      // it's exactly the sensitive data this assertion exists to catch, and
      // printing it would leak it into CI logs instead of just flagging it.
      if (label) failures.push(toFailureDetail(exchange, `${field} looks like it contains a ${label}`));
    }
  }
  return {
    name: assertion.name,
    type: assertion.type,
    passed: failures.length === 0,
    matchedCount: matched.length,
    failures,
  };
}

/** Evaluates every assertion in a `detour test` file against the exchanges captured during a run. Passthrough (undecrypted TLS tunnel) exchanges are excluded — they carry no real headers/body to check. */
export function evaluateAssertions(assertions: TestAssertion[], exchanges: CapturedExchange[]): AssertionResult[] {
  const candidates = exchanges.filter((e) => !e.passthrough);
  return assertions.map((assertion) => {
    const test = compileMatch(assertion.match);
    const matched = candidates.filter((e) => test({ method: e.method, url: e.url }));
    if (assertion.type === 'headerPresent') return evaluateHeaderPresent(assertion, matched);
    if (assertion.type === 'latencyP95') return evaluateLatencyP95(assertion, matched);
    return evaluateNoPiiLeak(assertion, matched);
  });
}
