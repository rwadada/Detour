import { describe, expect, it } from 'vitest';
import type { CapturedExchange, ExchangeTiming } from '../../domain/exchange/types';
import { attachTiming } from './attachTiming';
import type { IContext } from './engine/types';

function fakeExchange(finishedAt?: number): CapturedExchange {
  return { finishedAt } as unknown as CapturedExchange;
}

function fakeContext(timing: ExchangeTiming | undefined, responseHeadersAt?: number): IContext {
  return { timing, responseHeadersAt } as unknown as IContext;
}

describe('attachTiming', () => {
  it('does nothing when ctx.timing was never set (never dispatched upstream)', () => {
    const exchange = fakeExchange();
    attachTiming(exchange, fakeContext(undefined));
    expect(exchange.timing).toBeUndefined();
  });

  it('does not attach an all-undefined timing object (request errored before any phase completed)', () => {
    const exchange = fakeExchange();
    attachTiming(exchange, fakeContext({}));
    expect(exchange.timing).toBeUndefined();
  });

  it("does not attach a timing object whose only set field is connectionReused (issue #162's own Copilot finding: a reused-socket request that errored before response headers is not 'something happened')", () => {
    const exchange = fakeExchange();
    attachTiming(exchange, fakeContext({ connectionReused: true }));
    expect(exchange.timing).toBeUndefined();
  });

  it('attaches a timing object with connectionReused plus a real measured phase (the normal reused-connection case)', () => {
    const exchange = fakeExchange();
    attachTiming(exchange, fakeContext({ connectionReused: true, ttfbMs: 5 }));
    expect(exchange.timing).toEqual({ connectionReused: true, ttfbMs: 5 });
  });

  it('attaches a timing object with any single measured phase, connectionReused unset', () => {
    const exchange = fakeExchange();
    attachTiming(exchange, fakeContext({ dnsMs: 3 }));
    expect(exchange.timing).toEqual({ dnsMs: 3 });
  });

  it('fills in transferMs from finishedAt - responseHeadersAt before deciding whether to attach', () => {
    const exchange = fakeExchange(1000);
    const ctx = fakeContext({}, 970);
    attachTiming(exchange, ctx);
    expect(exchange.timing).toEqual({ transferMs: 30 });
  });
});
