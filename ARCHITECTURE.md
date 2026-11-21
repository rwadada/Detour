# Architecture decisions

Decisions about how Detour is built that aren't visible from any one file,
with what would make each worth revisiting. Layering itself (domain →
usecase → infra → presentation, the dashboard's FSD layers) is enforced by
ESLint and dependency-cruiser; see `eslint.config.mjs` and
`.dependency-cruiser.cjs`.

## Module format: CommonJS, loading ESM-only dependencies with `require(esm)` (issue #260)

**Decision: stay on CommonJS** (`"type": "commonjs"`, `tsc` emitting CJS,
`tsconfig` on `NodeNext` since #258), and keep loading ESM-only dependencies
— `commander` today — with Node's `require(esm)`.

What was checked (November 2026, `commander` 15.1.0):

- **`commander` has no top-level `await`** (the only failure mode of
  `require(esm)`: `ERR_REQUIRE_ASYNC_MODULE`), and its own `engines` is
  `>=22.12.0` — the first LTS with `require(esm)` on by default — so it is
  published expecting to be `require`d this way.
- **The Homebrew release never uses `require(esm)`**: `scripts/build-release.mjs`
  bundles the CLI with esbuild (`format: 'cjs'`, `bundle: true`), which turns
  `commander` into CommonJS inside the bundle. Only the npm/`dist/` install
  (`bin/detour.js` → `dist/cli.js` → `node_modules/commander`) relies on it.
- **Warnings**: Node 22.12.x can print an `ExperimentalWarning` the first time
  `require()` loads an ES module; from 22.13.0 (and 23.5.0) it doesn't unless
  `--trace-require-module` is given. CI's `compat (macos-latest, node
  22.12.0)` job (which runs the CLI through `tsx`) shows none. The worst case
  is one warning line on 22.12.x, not a failure.

Why not the alternatives:

- **Dynamic `import()` of `commander` only** would make startup asynchronous
  for a dependency that already loads synchronously, and rewrite `cli.ts`'s
  entry (`require.main === module`) and every command's registration — to
  remove a dependency on a Node feature that is now stable.
- **Moving the whole package to ESM** touches every relative import
  (extensions), `__dirname` (`dashboardServer.ts`'s `WEB_DIST_DIR`), the
  `require('…/package.json')` reads, the esbuild bundle and its
  `DETOUR_WEB_DIST_DIR` banner, `bin/detour.js` and the Homebrew formula —
  and changes behavior users see: `script` rules are CommonJS modules loaded
  with `require()` (`infra/fs/scriptModuleLoader.ts`), synchronously, and
  picked up again after an edit by clearing `require.cache`; ESM's `import()`
  is asynchronous and has no cache to clear, so reloading an edited script
  would need another mechanism.

**Revisit when** any of these happens:

1. A runtime dependency (`commander` or another) starts using top-level
   `await`, so `require()` of it throws `ERR_REQUIRE_ASYNC_MODULE`.
2. Node changes how `require(esm)` behaves or warns in a supported version.
3. The distribution format changes for another reason (the release bundle,
   the npm package), making the ESM migration cost mostly paid anyway.

A cheap follow-up, not done here: raising `engines.node` from `>=22.12.0` to
`>=22.13.0` would rule out the 22.12.x warning entirely (the CI matrix's
`22.12.0` floor would move with it).
