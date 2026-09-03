import { describe, expect, it } from 'vitest';
import { buildQrMatrix } from './qrMatrix';

// Plain host:port strings rather than a URL — this only exercises the
// generic QR encoder, not anything proxy-specific, and a literal `http://`
// trips `sonarjs/no-clear-text-protocols`.
const SAMPLE = '192.168.1.10:8080';

describe('buildQrMatrix', () => {
  it('returns a square grid', () => {
    const matrix = buildQrMatrix(SAMPLE);
    expect(matrix.length).toBeGreaterThan(0);
    for (const row of matrix) expect(row).toHaveLength(matrix.length);
  });

  it('is deterministic for the same input', () => {
    expect(buildQrMatrix(SAMPLE)).toEqual(buildQrMatrix(SAMPLE));
  });

  it('produces a larger grid for longer input', () => {
    const short = buildQrMatrix('a');
    const long = buildQrMatrix('a-very-long-hostname.example.internal.corp:65535/some/extra/path/segment');
    expect(long.length).toBeGreaterThan(short.length);
  });

  it('has at least one dark module (never an all-blank grid)', () => {
    const matrix = buildQrMatrix(SAMPLE);
    expect(matrix.some((row) => row.some((cell) => cell))).toBe(true);
  });
});
