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
    // only one consumer (widgets/toolbar), which `fsd/insignificant-slice`
    // flags as "just merge it into Toolbar" — but each is kept as its own
    // feature slice for its quick-access toolbar popover. (Their actual
    // *state* — `useInterceptStore` etc. — lives in `entities/proxy-config`
    // instead, precisely because it's shared by more than just this popover:
    // `features/session` and `features/settings-panel` also read/write it,
    // and FSD forbids feature→feature imports.)
    files: [
      './src/features/focus/**',
      './src/features/intercept-toggle/**',
      './src/features/throttle/**',
      './src/features/block-hosts/**',
    ],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  {
    // `log-export` currently has only one consumer (widgets/toolbar) too —
    // same reasoning as the block above. Kept as its own slice since a
    // future Settings panel section may want it independently.
    files: ['./src/features/log-export/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  {
    // `rules-editor`/`rules-profiles` (issue #19) are two independent
    // capabilities (form-editing rules.json vs. switching/creating saved
    // profiles) that happen to share one consumer today (widgets/sidebar) —
    // kept separate rather than merged for the same reason as the blocks
    // above, and because a future Settings panel is likely to want them as
    // distinct sections anyway.
    files: ['./src/features/rules-editor/**', './src/features/rules-profiles/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  {
    // `session` (issue #24's toolbar Save/Load) and `settings-panel` (issue
    // #24's sidebar Settings) each currently have one consumer too — same
    // reasoning as the blocks above.
    files: ['./src/features/session/**', './src/features/settings-panel/**'],
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
  {
    // `compare` (widgets/context-bar), `copy-as-curl`/`replay`
    // (widgets/inspector-panel) — issue #19 — each currently have one
    // consumer widget too, same reasoning as the blocks above: kept as
    // their own slices since they're independently reusable capabilities
    // (e.g. Copy as curl / Replay are also natural fits for a future
    // per-row context menu in LogTable).
    files: ['./src/features/compare/**', './src/features/copy-as-curl/**', './src/features/replay/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  {
    // `proxy-config` genuinely has six consumers — `grep -rln
    // "@/entities/proxy-config" src` confirms `features/intercept-toggle`,
    // `features/focus`, `features/throttle`, `features/block-hosts`,
    // `features/session`, and `features/settings-panel` all import from it,
    // and `tsc`/`vitest` resolve every one of those imports without error.
    // `fsd/insignificant-slice` still reports "no references" here
    // regardless — the same known Steiger 0.5 cross-slice reference-tracing
    // false negative documented on `entities/rule` above, not an actual
    // structural issue. Silenced for the same reason.
    files: ['./src/entities/proxy-config/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  {
    // `log-view` genuinely has two consumers — `widgets/log-table` (reads
    // sort/group/columnWidths to render) and `features/group-by-host`
    // (toggles `groupByHost`); `grep -rn "@/entities/log-view" src`
    // confirms both, and `tsc`/`vitest` resolve them without error.
    // `fsd/insignificant-slice` still reports only one reference here
    // regardless — the same known Steiger 0.5 cross-slice reference-tracing
    // false negative documented on `entities/rule` above, not an actual
    // structural issue. Silenced for the same reason.
    files: ['./src/entities/log-view/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  {
    // `group-by-host`/`pause-tail` (issue #24's toolbar) — same reasoning
    // as the blocks above: each is its own toggle-able capability with a
    // single consumer today (widgets/toolbar), kept separate rather than
    // inlined there since Phase 4/5 of issue #24 (Settings panel,
    // localStorage-persisted view preferences) are likely to want each as
    // an independent unit again.
    files: ['./src/features/group-by-host/**', './src/features/pause-tail/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
]);
