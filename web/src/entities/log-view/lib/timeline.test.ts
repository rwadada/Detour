import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from '@/shared/api';
import { computeTimelineBar, computeTimelineSpan } from './timeline';

function exchange(overrides: Partial<CapturedExchange> & { id: string }): CapturedExchange {
  return {
    method: 'GET',
    url: 'https://example.com/',
    host: 'example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    startedAt: 0,
    responseBodySize: 0,
    ...overrides,
  };
}

describe('computeTimelineSpan', () => {
  it('returns null for an empty list', () => {
    expect(computeTimelineSpan([])).toBeNull();
  });

  it('spans from the earliest start to the latest finish', () => {
    const span = computeTimelineSpan([
      exchange({ id: 'a', startedAt: 100, finishedAt: 400 }),
      exchange({ id: 'b', startedAt: 200, finishedAt: 300 }),
    ]);
    expect(span).toEqual({ min: 100, max: 400 });
  });

  it('falls back to startedAt for a still-pending exchange (no finishedAt)', () => {
    const span = computeTimelineSpan([
      exchange({ id: 'a', startedAt: 100, finishedAt: 400 }),
      exchange({ id: 'b', startedAt: 500 }),
    ]);
    expect(span).toEqual({ min: 100, max: 500 });
  });

  it('never returns a zero-width span, even for a single instantaneous row', () => {
    const span = computeTimelineSpan([exchange({ id: 'a', startedAt: 100, finishedAt: 100 })]);
    expect(span?.max).toBeGreaterThan(span?.min ?? 0);
  });
});

describe('computeTimelineBar', () => {
  it('positions a bar proportionally within the span', () => {
    const span = { min: 0, max: 1000 };
    const bar = computeTimelineBar(exchange({ id: 'a', startedAt: 200, finishedAt: 400 }), span);
    expect(bar.offsetPct).toBeCloseTo(20);
    expect(bar.widthPct).toBeCloseTo(20);
  });

  it('gives a still-pending exchange a visible minimum width instead of zero', () => {
    const span = { min: 0, max: 1000 };
    const bar = computeTimelineBar(exchange({ id: 'a', startedAt: 500 }), span);
    expect(bar.widthPct).toBeGreaterThan(0);
  });

  it('never lets offset + width exceed 100%', () => {
    const span = { min: 0, max: 1000 };
    const bar = computeTimelineBar(exchange({ id: 'a', startedAt: 999 }), span);
    expect(bar.offsetPct + bar.widthPct).toBeLessThanOrEqual(100);
  });
});
