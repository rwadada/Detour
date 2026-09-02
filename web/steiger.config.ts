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
    // `proxy-error` mirrors `ProxyErrorEvent` messages the server already
    // sends, but no UI surfaces them yet (the pre-FSD store had this same
    // capture-but-never-render gap — see git history). Kept ready for
    // #19/#24's planned error surface rather than dropped and re-added
    // later.
    files: ['./src/entities/proxy-error/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
]);
