/**
 * Match criteria for a `detour test` assertion (issue #148) — deliberately
 * the same shape as `RuleMatch` (domain/rules/types.ts): a method filter
 * plus a `url` glob or `urlRegex`. Kept as its own type rather than reusing
 * `RuleMatch` directly so this domain doesn't quietly break if the rule
 * engine's match shape ever grows a rewrite-specific field that wouldn't
 * make sense here.
 */
export interface TestMatch {
  method?: string | string[];
  url?: string;
  urlRegex?: string;
  urlRegexFlags?: string;
}

/** Built-in best-effort PII detectors for `noPiiLeak` — see `piiPatterns.ts`. Heuristic, not exhaustive: a contract test using this should treat a pass as "no *obvious* leak", not a compliance guarantee. */
export type PiiPatternName = 'email' | 'creditCard' | 'ssn';

/**
 * Fails unless every exchange matching `match` carries `header` on the given
 * `phase` (case-insensitive, matching Node's own lowercased header keys).
 * Also fails when nothing matched at all, unless `allowNoMatches` is set —
 * a `match` pattern that never fires during a run is almost always a typo,
 * not something to silently pass.
 */
export interface HeaderPresentAssertion {
  type: 'headerPresent';
  name: string;
  match: TestMatch;
  /** @default 'request' */
  phase?: 'request' | 'response';
  header: string;
  allowNoMatches?: boolean;
}

/**
 * Fails if any exchange matching `match` carries a built-in (`patterns`) or
 * custom (`customPatterns`, raw regex source tested case-insensitively)
 * PII-shaped value in its request/response headers or body. Unlike
 * `headerPresent`/`latencyP95`, zero matching exchanges always passes —
 * there's nothing to have leaked.
 */
export interface NoPiiLeakAssertion {
  type: 'noPiiLeak';
  name: string;
  match: TestMatch;
  patterns?: PiiPatternName[];
  customPatterns?: string[];
}

/** Fails if the p95 of `durationMs` across every exchange matching `match` exceeds `maxMs`, or (unless `allowNoMatches`) if nothing matched. */
export interface LatencyP95Assertion {
  type: 'latencyP95';
  name: string;
  match: TestMatch;
  maxMs: number;
  allowNoMatches?: boolean;
}

export type TestAssertion = HeaderPresentAssertion | NoPiiLeakAssertion | LatencyP95Assertion;

/** A `detour test` assertions file (default: `detour.test.json` in the current directory). Deliberately a separate file from `rules.json` — an assertion checks traffic, a rule mutates it, and conflating the two schemas would make both harder to validate and document. */
export interface TestFile {
  $schema?: string;
  assertions: TestAssertion[];
}
