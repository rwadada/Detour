import { DetourLogo } from '@/shared/ui';

/**
 * True when the splash animation (issue #24's design guide: "route drawing
 * → title fade-in") should be skipped outright — `App` renders immediately
 * with no overlay at all rather than a near-instant one, since a browser
 * matching any of these isn't a person watching an intro:
 *  - `navigator.webdriver`: set by every major automation driver (Playwright,
 *    Selenium, Puppeteer) — the design guide's "headless" case.
 *  - `?no-animation` in the URL: an explicit manual escape hatch for the
 *    same case when `navigator.webdriver` isn't set (e.g. a screenshot tool
 *    driving a real, non-automated-flagged browser instance).
 * `prefers-reduced-motion` is handled separately, in CSS (see index.css) —
 * every duration/delay this component's animations use collapses to ~0
 * there, which already produces an effectively-instant, skip-like reveal
 * without this component needing to know about it.
 */
export function shouldSkipSplash(): boolean {
  if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('no-animation')) return true;
  return false;
}

/**
 * One-time startup splash (issue #24's design guide): the logo's route
 * draws in, "Detour" fades in after it, then the whole overlay fades out —
 * calling `onDone` so the caller can reveal the app underneath (see
 * `app-float-in` in index.css) instead of unmounting itself on a timer.
 * `AppShell` skips rendering this entirely per `shouldSkipSplash`.
 */
export function SplashScreen({ onDone }: { onDone: () => void }) {
  return (
    <div
      className="detour-splash-overlay fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-[var(--background)]"
      onAnimationEnd={(event) => {
        if (event.animationName === 'detour-splash-out') onDone();
      }}
    >
      <DetourLogo className="h-16 w-16 rounded-2xl" animated />
      <div className="detour-splash-title text-base font-semibold tracking-tight">Detour</div>
    </div>
  );
}
