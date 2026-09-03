import { defineConfig } from 'vitest/config';

/**
 * Covers the CLI/proxy package's unit tests (`src/**\/*.test.ts`) — pure,
 * synchronous rule-engine logic (matching, schema validation, rewrite/mock
 * helpers) that doesn't need a live proxy or network. The web dashboard is a
 * separate Vite package and gets its own test config if/when it needs one.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // `*.e2e.test.ts` (spawns the real CLI as a subprocess against real
    // sockets) has its own config — see vitest.e2e.config.ts — since it
    // needs a longer timeout and coverage instrumentation of this process
    // wouldn't see anything happening in the spawned one anyway.
    exclude: ['node_modules/**', 'dist/**', 'web/**', '**/__*', '**/*.e2e.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      // The Domain layer (pure matching/validation/rewrite/mock/route/
      // throttle/focus logic, no I/O) and UseCase layer (RuleEngine and the
      // rule-resolution/breakpoint orchestration, dependency-injected against
      // fakes in tests) are fully under unit test here, plus the two
      // Infrastructure adapters (rulesFileSource.ts, actionsRuntime.ts) with
      // direct behavioral tests of their own. The rest of Infrastructure
      // (proxyServer.ts, dashboardServer.ts, certStore.ts, portCheck.ts,
      // eventBus.ts) and Presentation (logger.ts) plus the cli.ts composition
      // root are callback-driven glue around http-mitm-proxy/ws/fs — exercised
      // by the CLI E2E test (vitest.e2e.config.ts) instead of unit tests, and
      // holding them to a unit-test branch-coverage gate would either be
      // unenforceable or force low-value tests built entirely out of mocks.
      // Widen this include list as real unit tests for that code are added.
      include: [
        'src/domain/**/*.ts',
        'src/usecase/**/*.ts',
        'src/infra/fs/rulesFileSource.ts',
        'src/infra/fs/scriptModuleLoader.ts',
        'src/infra/proxy/actionsRuntime.ts',
      ],
      exclude: ['src/**/*.test.ts', 'src/domain/rules/sample.ts'],
      // C1 (branch coverage) ~85%, per team convention.
      thresholds: {
        branches: 85,
      },
    },
  },
});
