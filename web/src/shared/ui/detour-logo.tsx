/**
 * The app's mark: the route actually taken (an accent-colored line that
 * bends away and back) drawn over the straight one it detoured from (a
 * faint dashed backdrop) — the two together read as "detour" more directly
 * than a single bent line can on its own. Replaces the original forking-road
 * motif (a straight line splitting into two), which read as the letter "Y"
 * before it read as a road.
 *
 * Mirrors `public/favicon.svg` by hand (same route path data, kept in sync
 * manually — same reasoning as the backend/frontend protocol mirrors
 * elsewhere in this repo: the favicon has to be a static file Vite can
 * serve as-is, so it can't import this component) — except the favicon
 * drops the dashed straight-line backdrop entirely, since at a 16-32px
 * favicon size it disappears into noise rather than reading as a road.
 *
 * `pathLength="1"` on the stroked route path lets `SplashScreen` animate its
 * `stroke-dashoffset` in normalized 0–1 units regardless of the path's
 * actual geometric length. The dashed backdrop is static — nothing about
 * "the straight road not taken" should draw itself in.
 *
 * `decorative`: pass `true` when adjacent visible text already says
 * "Detour" (the expanded sidebar header, the splash title) — otherwise a
 * screen reader announces "Detour" twice in a row for the same mark.
 * Defaults to `false` (an accessible `role="img"`/`aria-label`) for a
 * standalone use with no such text nearby.
 */
export function DetourLogo({
  className,
  animated = false,
  decorative = false,
}: {
  className?: string;
  animated?: boolean;
  decorative?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : 'Detour'}
      aria-hidden={decorative ? 'true' : undefined}
    >
      <rect width="64" height="64" rx="14" fill="#0f1117" />
      <line
        x1="10"
        y1="32"
        x2="54"
        y2="32"
        stroke="#3a4152"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="0.5 6.5"
      />
      <path
        d="M10 32 L22 32 L32 18 L42 46 L54 32"
        fill="none"
        stroke="#5eb3e8"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={animated ? 1 : undefined}
        className={animated ? 'detour-logo-route' : undefined}
      />
      <circle cx="10" cy="32" r="4" fill="#5eb3e8" />
      <circle cx="54" cy="32" r="4" fill="#e6eaf2" />
    </svg>
  );
}
