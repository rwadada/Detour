import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Covers the dashboard SPA's unit tests (`src/**\/*.test.ts`) — the store
 * and pure helpers (`ringBuffer.ts`, `useLogStore.ts`), tested against fakes
 * rather than a real WebSocket/DOM. Component rendering isn't covered here;
 * add `jsdom`/`@testing-library/react` if/when component tests are needed.
 * Deliberately its own minimal config rather than extending vite.config.ts:
 * the `@vitejs/plugin-react`/dev-server proxy setup there is irrelevant to
 * running plain TS unit tests, so this only mirrors the one thing tests
 * actually need from it — the `@/` alias.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
