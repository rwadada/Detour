/**
 * The app's mark (issue #24's design guide: a rounded-square icon with a
 * forking-road motif) — a route splitting into two, echoing "Detour".
 * Mirrors `public/favicon.svg` by hand (same path data, kept in sync
 * manually — same reasoning as the backend/frontend protocol mirrors
 * elsewhere in this repo: the favicon has to be a static file Vite can
 * serve as-is, so it can't import this component).
 *
 * `pathLength="1"` on the stroked path lets `SplashScreen` animate its
 * `stroke-dashoffset` in normalized 0–1 units regardless of the path's
 * actual geometric length.
 */
export function DetourLogo({ className, animated = false }: { className?: string; animated?: boolean }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="Detour">
      <rect width="64" height="64" rx="14" fill="#0f1117" />
      <path
        d="M32 54 L32 36 L16 14 M32 36 L48 14"
        fill="none"
        stroke="#5eb3e8"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={animated ? 1 : undefined}
        className={animated ? 'detour-logo-route' : undefined}
      />
      <circle cx="32" cy="54" r="4" fill="#5eb3e8" />
      <circle cx="16" cy="14" r="4" fill="#e6eaf2" />
      <circle cx="48" cy="14" r="4" fill="#e6eaf2" />
    </svg>
  );
}
