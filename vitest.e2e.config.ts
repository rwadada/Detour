import { defineConfig } from 'vitest/config';

/**
 * CLI end-to-end tests: spawns the real `detour start` CLI (via `tsx`, no
 * build step needed) as a subprocess and drives it over real sockets — the
 * class of bug unit tests (vitest.config.ts) structurally can't catch
 * (a hung socket, a certificate rejected, ProxyEngine's hooks wired up
 * wrong end-to-end). Kept in its own config/run: slower (real process
 * spawn + network I/O) and not meaningful to fold into the coverage number
 * a separate process's instrumentation wouldn't see anyway.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.e2e.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'web/**', '**/__*'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
