// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import boundaries from 'eslint-plugin-boundaries';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';
import vitest from '@vitest/eslint-plugin';

/**
 * Flat ESLint config covering both workspaces from the repo root:
 *  - `src/**`, the Node/CLI package (CommonJS, `node:*` APIs)
 *  - `web/src/**`, the React dashboard (browser APIs, JSX)
 *
 * Type-aware (`recommendedTypeChecked`) rules are deliberately skipped in
 * favor of the plain `recommended` sets: this config is meant to run on
 * every Claude Code Stop hook, so keeping it fast (no TS program build) and
 * dependency-light (no per-glob `parserOptions.project` wiring across two
 * separate tsconfigs) matters more here than the extra type-flow checks
 * would buy. `npm run typecheck` already covers type correctness.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'web-dist/**',
      'web/dist/**',
      'node_modules/**',
      'web/node_modules/**',
      'coverage/**',
      '**/__*',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  {
    rules: {
      // Past ~4 positional params, callers routinely mis-order same-typed
      // arguments at a call site with no compiler help — an options object
      // makes the mistake structurally impossible instead of relying on
      // reviewers to catch it.
      'max-params': ['warn', 4],
      'max-lines-per-function': ['warn', { max: 60, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // The published CLI entry point, and root-level tool configs: plain
    // CommonJS (matches the root package.json's `"type": "commonjs"`), not
    // compiled from TypeScript.
    files: ['bin/**/*.js', '*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // CLI/proxy/dashboard-server package: Node, CommonJS.
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    plugins: { boundaries },
    settings: {
      // eslint-plugin-boundaries resolves each import's target file to
      // check it against the element rules below; without a TS-aware
      // resolver it can't follow extensionless relative imports (`./types`
      // → `./types.ts`) and every local dependency silently resolves as
      // "unknown" — which the element-type check below then treats as
      // exempt, defeating the whole rule.
      'import/resolver': {
        typescript: { project: 'tsconfig.json' },
      },
      // Layered architecture (see issue #29): Domain → UseCase → Infra/
      // Presentation, enforced mechanically below rather than by convention.
      // Element patterns intentionally name only the folder (no file
      // extension) — every file nested under it, at any depth, inherits
      // that element's type. `src/cli.ts` deliberately matches none of
      // these — it's the composition root, the one place allowed to wire
      // concrete Infra adapters into UseCases (see cli.ts's own doc
      // comment). `*.test.ts` files are classified separately, by file
      // category (see `boundaries/files` below), so a test living under
      // e.g. usecase/ (like ruleEngine.test.ts, which wires a real Infra
      // adapter for an integration-style test) isn't held to the same
      // restrictions as the UseCase code it's testing.
      'boundaries/elements': [
        { type: 'domain', pattern: 'src/domain/**' },
        { type: 'usecase', pattern: 'src/usecase/**' },
        { type: 'infra', pattern: 'src/infra/**' },
        { type: 'presentation', pattern: 'src/presentation/**' },
      ],
      'boundaries/files': [{ category: 'test', pattern: 'src/**/*.test.ts' }],
    },
    rules: {
      // The rule engine's action handlers intentionally build up largish,
      // sequential functions (e.g. proxyServer.ts's onRequest/onResponse
      // hooks) that read more clearly kept together than artificially
      // split apart — flag genuinely tangled logic via complexity instead.
      'sonarjs/cognitive-complexity': ['warn', 25],
      // Wrapping Node's callback-based listen()/close() APIs in a Promise
      // inherently nests a couple of levels deep (executor → listen
      // callback → resolve({ stop: () => new Promise(...) })) — this is a
      // standard, narrow idiom (proxyServer.ts, dashboardServer.ts), not
      // tangled control flow; extracting each one-line callback into a
      // named top-level function would only lose locality.
      'sonarjs/no-nested-functions': ['warn', { threshold: 6 }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Domain depends on nothing internal; UseCase depends only on Domain;
      // Infra/Presentation may depend on Domain/UseCase and their own kind,
      // but not on each other — only the composition root (src/cli.ts,
      // unclassified above) is allowed to wire both together. `*.test.ts`
      // files (the `test` file category, see `boundaries/files` above) may
      // import anything, for integration-style test setup.
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            {
              from: { file: { categories: 'test' } },
              allow: { to: { element: { types: { anyOf: ['domain', 'usecase', 'infra', 'presentation'] } } } },
            },
            { from: { element: { type: 'domain' } }, allow: { to: { element: { type: 'domain' } } } },
            {
              from: { element: { type: 'usecase' } },
              allow: { to: { element: { types: { anyOf: ['domain', 'usecase'] } } } },
            },
            {
              from: { element: { type: 'infra' } },
              allow: { to: { element: { types: { anyOf: ['domain', 'usecase', 'infra'] } } } },
            },
            {
              from: { element: { type: 'presentation' } },
              allow: { to: { element: { types: { anyOf: ['domain', 'usecase', 'presentation'] } } } },
            },
          ],
        },
      ],
    },
  },
  {
    // Dashboard SPA: browser, React, JSX/TSX. Builds as its own standalone
    // Vite package (see web/src/types.ts's doc comment on why types are
    // hand-mirrored rather than imported across the package boundary).
    files: ['web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React Compiler-specific: irrelevant noise since this project isn't
      // opted into the compiler (no babel-plugin-react-compiler in the
      // build) — @tanstack/react-virtual's non-memoizable API is expected.
      'react-hooks/incompatible-library': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'sonarjs/cognitive-complexity': ['warn', 20],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Test files: relax a couple of sonarjs rules that fight normal test
    // idioms (e.g. deliberately duplicated literals/assertions across
    // cases), and guard against hollow tests — a case with no assertion
    // passes trivially, and a disabled or deferred case silently stops
    // being run, both of which defeat a coverage number's whole point.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    plugins: { vitest },
    rules: {
      'sonarjs/no-duplicate-string': 'off',
      'sonarjs/no-identical-functions': 'off',
      // A long `describe`/`it` reflects test *count*, not one function doing
      // too much — not the same code smell `max-lines-per-function` targets.
      'max-lines-per-function': 'off',
      'vitest/expect-expect': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
    },
  },
);
