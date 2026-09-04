#!/usr/bin/env node
'use strict';

// Builds the self-contained release tarball published to GitHub Releases and
// consumed by the Homebrew formula (issue #52). Unlike `npm run build`
// (which produces `dist/` + `web-dist/` for `npm start`/a global npm
// install), this bundles the CLI into a single CommonJS file with esbuild so
// the tarball needs nothing beyond a `node` binary at install time — no
// `node_modules`, no per-dependency Homebrew `resource` stanzas.
//
// Output layout (tarred up with the staging dir itself as the tar root, so
// extracting the tarball drops these paths directly into the install dir):
//   detour       - single executable file: esbuild bundle of src/cli.ts,
//                  entry point itself (so `require.main === module` inside
//                  cli.ts still holds — see the note on `outfile` below)
//   web-dist/     - built dashboard SPA (copied from the repo-root build)
//
// `detour` locates `web-dist/` via `__dirname`, so this layout must stay
// intact relative to itself — the Homebrew formula installs the whole
// staging dir under `libexec` and symlinks `libexec/detour` into `bin`
// rather than moving files around individually.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const releaseDir = path.join(repoRoot, 'release');
const stagingDir = path.join(releaseDir, 'pkg');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
}

function main() {
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  // 1. Build the dashboard SPA (web-dist/) — the CLI bundle serves it as
  // static files, it isn't itself bundled into the CLI's JS.
  run('npm', ['run', 'build', '--workspace', 'web']);

  // 2. Bundle the CLI into a single, directly-executable CommonJS file.
  //
  // `src/cli.ts` only self-invokes (`createCli().parse(...)`) when
  // `require.main === module` — true when Node runs it directly, false when
  // something else `require()`s it first. esbuild only exempts the *entry
  // point itself* from its CommonJS-wrapping helper, so this file must BOTH
  // be the esbuild entry point AND be the file Node executes directly (no
  // separate bin/ shim in front of it) or that check silently sees `false`
  // and the CLI does nothing.
  //
  // The banner (real top-level code in the unwrapped entry module, so
  // `__dirname` resolves correctly) supplies the shebang and points
  // `DETOUR_WEB_DIST_DIR` at the sibling `web-dist/` this script copies in
  // below — see the matching override in dashboardServer.ts. `bufferutil`/
  // `utf-8-validate` are optional native addons `ws` tries to `require` in a
  // try/catch and neither is a real dependency here — mark them external so
  // esbuild doesn't fail trying to resolve them, leaving the (already
  // try/catch-guarded) `require()` calls for Node to fail gracefully at
  // runtime instead.
  const outfile = path.join(stagingDir, 'detour');
  esbuild.buildSync({
    absWorkingDir: repoRoot,
    entryPoints: ['src/cli.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['bufferutil', 'utf-8-validate'],
    legalComments: 'none',
    logLevel: 'info',
    banner: {
      js: [
        '#!/usr/bin/env node',
        "process.env.DETOUR_WEB_DIST_DIR = process.env.DETOUR_WEB_DIST_DIR || require('node:path').join(__dirname, 'web-dist');",
      ].join('\n'),
    },
  });
  // Marking our own freshly-built release binary executable (0o755, the same
  // mode `bin/detour.js` already has in git) — not attacker-controlled input.
  // eslint-disable-next-line sonarjs/file-permissions
  fs.chmodSync(outfile, 0o755);

  // 4. Copy the built dashboard SPA alongside the bundle.
  fs.cpSync(path.join(repoRoot, 'web-dist'), path.join(stagingDir, 'web-dist'), { recursive: true });

  // 5. Sanity check: actually start the proxy and confirm it comes up (not
  // just `--help`, which stays silent about `require.main === module` /
  // `DETOUR_WEB_DIST_DIR` wiring mistakes that leave the CLI a no-op).
  const smoke = execFileSync(
    outfile,
    ['start', '--port', '0', '--dashboard-port', '0', '--exit-on-idle', '500'],
    { encoding: 'utf8' },
  );
  if (!smoke.includes('DETOUR_READY')) {
    throw new Error(`Release bundle smoke test failed — no DETOUR_READY line in output:\n${smoke}`);
  }

  // 6. Tar it up with the staging dir's contents at the tar root.
  const tarballName = `detour-${pkg.version}.tar.gz`;
  const tarballPath = path.join(releaseDir, tarballName);
  run('tar', ['-czf', tarballPath, '-C', stagingDir, '.']);

  const sha256 = createHash('sha256').update(fs.readFileSync(tarballPath)).digest('hex');
  console.log(`\nBuilt ${path.relative(repoRoot, tarballPath)}`);
  console.log(`sha256: ${sha256}`);
}

main();
