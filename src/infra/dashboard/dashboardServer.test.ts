import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEB_DIST_DIR } from './dashboardServer';

describe('WEB_DIST_DIR', () => {
  it('resolves to <package root>/web-dist, not nested a level too deep under dist/', () => {
    // Regression test for a path miscalculation introduced by the Clean
    // Architecture move (issue #29): this file moved from `src/dashboard/`
    // to `src/infra/dashboard/` (one extra level of nesting) without
    // updating `WEB_DIST_DIR`'s relative-path arithmetic, so `detour start`
    // could never find a dashboard build that genuinely existed —
    // `WEB_DIST_DIR` resolved to `dist/web-dist` instead of the actual
    // `<package root>/web-dist` (a sibling of `dist/`, per package.json's
    // `files` list). `tsconfig.json`'s `rootDir: "src"`/`outDir: "dist"`
    // mirror this file's nesting exactly, so proving the arithmetic here
    // (evaluated from `src/infra/dashboard/`, as vitest runs it) also
    // proves it for the compiled `dist/infra/dashboard/` layout.
    expect(path.basename(WEB_DIST_DIR)).toBe('web-dist');
    const packageRoot = path.dirname(WEB_DIST_DIR);
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('detour');
  });
});
