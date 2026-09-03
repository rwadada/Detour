import { defineConfig } from 'steiger';
import fsd from '@feature-sliced/steiger-plugin';

/**
 * Enforces Feature-Sliced Design's layer/slice rules across `src/`
 * (app → widgets → features → entities → shared; see ARCHITECTURE.md at
 * the repo root). `pages`/`processes` are unused — this dashboard is a
 * single view with no routing, so there's nothing for either layer to hold.
 */
export default defineConfig([
  ...fsd.configs.recommended,
  {
    // `focus`/`intercept-toggle`/`throttle`/`block-hosts` currently have
    // only one consumer (widgets/header), which `fsd/insignificant-slice`
    // flags as "just merge it into Header" — but each is kept as its own
    // feature slice because issues #24/#19 plan to relocate them
    // independently (toolbar/sidebar/Settings panel); merging now would
    // just be undone later.
    files: [
      './src/features/focus/**',
      './src/features/intercept-toggle/**',
      './src/features/throttle/**',
      './src/features/block-hosts/**',
    ],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  {
    // `log-export` currently has only one consumer (widgets/header) too —
    // same reasoning as the block above. Kept as its own slice since #19's
    // planned toolbar/Settings relocation applies here as well.
    files: ['./src/features/log-export/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  {
    // `rules-editor`/`rules-profiles` (issue #19) are two independent
    // capabilities (form-editing rules.json vs. switching/creating saved
    // profiles) that happen to share one consumer today (widgets/header) —
    // kept separate rather than merged for the same reason as the blocks
    // above, and because a future Settings panel is likely to want them as
    // distinct sections anyway.
    files: ['./src/features/rules-editor/**', './src/features/rules-profiles/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  {
    // `proxy-error` mirrors `ProxyErrorEvent` messages the server already
    // sends, but no UI surfaces them yet (the pre-FSD store had this same
    // capture-but-never-render gap — see git history). Kept ready for
    // #19/#24's planned error surface rather than dropped and re-added
    // later.
    files: ['./src/entities/proxy-error/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  {
    // `rule` genuinely has two consumers (`features/rules-editor` and
    // `features/rules-profiles` both import `useRuleStore` from it —
    // `grep -rn "@/entities/rule" src` confirms it, and both `tsc` and
    // `vitest` resolve the imports without error). `fsd/insignificant-slice`
    // still reports "no references" here regardless — a false negative in
    // Steiger 0.5's own cross-slice reference tracing (`traceSliceReferences`
    // in `@feature-sliced/steiger-plugin`), not an actual structural issue.
    // Silenced rather than misrepresenting the slice's real usage.
    files: ['./src/entities/rule/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
]);
