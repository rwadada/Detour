// @ts-check
/**
 * Mutation testing: run `npm run test:mutation` to check whether the unit
 * suite (vitest.config.ts) actually catches bugs, not just whether it hits
 * lines — Stryker flips a condition/operator/literal and expects a test to
 * fail; a "surviving" mutant means no test would notice that change.
 *
 * Deliberately NOT part of `npm run verify` (and so not run by
 * .claude/hooks/verify-stop.sh on every turn): mutation testing re-runs the
 * whole suite once per mutant, so it's minutes rather than the ~1s the rest
 * of `verify` takes. Run it periodically (e.g. weekly) or in CI, not as a
 * per-change gate.
 *
 * Scoped to the same files vitest.config.ts's coverage gate covers (pure
 * rule-engine logic) — mutating callback-driven proxy/dashboard wiring
 * without integration-level tests to catch it would just report every
 * mutant there as "no coverage", not a useful signal.
 */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
  },
  mutate: [
    'src/rules/matcher.ts',
    'src/rules/schema.ts',
    'src/rules/actions.ts',
    'src/rules/loader.ts',
    'src/rules/ruleEngine.ts',
    'src/ringBuffer.ts',
  ],
  reporters: ['html', 'clear-text', 'progress'],
  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },
  coverageAnalysis: 'perTest',
};
