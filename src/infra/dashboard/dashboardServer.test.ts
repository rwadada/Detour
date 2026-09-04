import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  describe('DETOUR_WEB_DIST_DIR override', () => {
    afterEach(() => {
      delete process.env.DETOUR_WEB_DIST_DIR;
      vi.resetModules();
    });

    it('takes precedence over the __dirname-relative default (issue #52 release bundle)', async () => {
      // The single-file esbuild release bundle flattens away the
      // `dist/infra/dashboard` nesting the default path depends on (see the
      // comment above `WEB_DIST_DIR`), so its entry file sets this env var
      // itself instead of relying on directory depth.
      const overridePath = path.join(os.tmpdir(), 'some-other-web-dist');
      process.env.DETOUR_WEB_DIST_DIR = overridePath;
      vi.resetModules();
      const { WEB_DIST_DIR: overridden } = await import('./dashboardServer');
      expect(overridden).toBe(path.resolve(overridePath));
    });
  });
});
