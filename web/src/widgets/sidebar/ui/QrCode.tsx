import { useMemo } from 'react';
import { buildQrMatrix } from '../lib/qrMatrix';

/**
 * Renders `value` (the proxy URL) as a scannable QR code (issue #24) — for
 * pointing a phone/tablet's proxy settings at it without typing. Always a
 * plain white background with black modules regardless of the app's
 * dark/light theme: a QR scanner needs strong, standard contrast, and this
 * is the one place in the dashboard where "matches the theme" would work
 * against the control's actual job.
 */
export function QrCode({ value, size = 132 }: { value: string; size?: number }) {
  const matrix = useMemo(() => buildQrMatrix(value), [value]);
  const count = matrix.length;

  return (
    <svg
      viewBox={`0 0 ${count} ${count}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`QR code for ${value}`}
      className="rounded bg-white p-1"
    >
      {matrix.flatMap((row, y) =>
        row.map((dark, x) => (dark ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#000" /> : null)),
      )}
    </svg>
  );
}
