import type { CapturedExchange } from '../../domain/exchange/types';
import type { IContext } from './engine/types';

/**
 * Copies `ctx.timing` (per-phase upstream timing, set by ProxyEngine as the
 * request/response actually progresses) onto the exchange, but only for one
 * that *did* reach upstream (a `mock`/blocked/request-phase-aborted
 * response never does, so never calls this).
 */
export function attachTiming(exchange: CapturedExchange, ctx: IContext): void {
  if (!ctx.timing) return;
  if (ctx.responseHeadersAt !== undefined && exchange.finishedAt !== undefined) {
    ctx.timing.transferMs = exchange.finishedAt - ctx.responseHeadersAt;
  }
  // `ctx.timing` is set (to `{}`) the moment `makeProxyToServerRequest`
  // dispatches, before any phase actually completes — a request that
  // errors synchronously right after that (before even a 'socket' event)
  // would otherwise attach a timing object with every field `undefined`,
  // contradicting `CapturedExchange.timing`'s own doc comment ("absent
  // for an exchange that never reached upstream" — in every way that
  // actually matters here, one whose upstream connection never got far
  // enough to measure anything is the same case).
  if (Object.values(ctx.timing).every((value) => value === undefined)) return;
  exchange.timing = ctx.timing;
}
