// Fails when package-lock.json installs a second copy of a package that the
// root and the `web` workspace must share (issue #306).
//
// A Dependabot PR that bumps `vite` in web/package.json alone used to leave
// the root's hoisted vite (the one vitest and @vitejs/plugin-react resolve)
// on the old version, so npm nested another vite under web/node_modules —
// and `tsc` then failed on web/vite.config.ts with "TS2321: Excessive stack
// depth", which says nothing about the real cause. This check names it.
import { readFileSync } from 'node:fs';

const MUST_BE_SINGLE = ['vite', 'vitest', '@vitejs/plugin-react'];

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const problems = [];
for (const name of MUST_BE_SINGLE) {
  const copies = Object.entries(lock.packages ?? {})
    .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
    .map(([key, entry]) => `${key}@${entry.version}`);
  if (copies.length > 1) problems.push(`${name}: ${copies.join(', ')}`);
}

if (problems.length > 0) {
  console.error('package-lock.json installs more than one copy of a package the root and web/ must share:');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    'Align the version range in package.json and web/package.json, then run `npm install` (or `npm update <name> --package-lock-only`) so a single copy is hoisted.',
  );
  process.exit(1);
}
