import type { CapturedExchange, ExchangeResponsePatch, WireExchange } from './types';

/**
 * The one place a `CapturedExchange`'s `requestBody`/`responseBody`
 * `Buffer`s get base64-encoded into a `WireExchange` (issue #165's
 * Proposal B) — called right before something JSON-serializes an exchange:
 * `dashboardServer.ts`'s broadcasts, and `historyStore.ts`'s SQLite writes.
 * Everything else about the exchange passes through unchanged; only these
 * two fields actually differ in shape between the two types.
 */
export function toWireExchange(exchange: CapturedExchange): WireExchange {
  return {
    ...exchange,
    requestBody: exchange.requestBody?.toString('base64'),
    responseBody: exchange.responseBody?.toString('base64'),
  };
}

/**
 * The inverse of `toWireExchange` — `historyStore.ts` calls this on a
 * `WireExchange` read back from its `data` column's JSON text (that
 * column's on-disk shape doesn't change at all across this issue: it was
 * already base64 text, same as `WireExchange`, so an existing `--persist`
 * database needs no migration) to hand the rest of the app back the
 * `Buffer`-based `CapturedExchange` it expects everywhere internally.
 */
export function fromWireExchange(wire: WireExchange): CapturedExchange {
  return {
    ...wire,
    requestBody: wire.requestBody !== undefined ? Buffer.from(wire.requestBody, 'base64') : undefined,
    responseBody: wire.responseBody !== undefined ? Buffer.from(wire.responseBody, 'base64') : undefined,
  };
}

/**
 * Builds a `response` dashboard message's payload (issue #165's Proposal
 * C) — same base64 encoding as `toWireExchange`, minus `requestBody`/
 * `requestHeaders`: the client already has both in full from this same
 * id's earlier `request` message, and neither ever changes by the time a
 * `response` event fires. See `ExchangeResponsePatch`'s own doc comment.
 */
export function toResponsePatch(exchange: CapturedExchange): ExchangeResponsePatch {
  // eslint-disable-next-line sonarjs/no-unused-vars -- deliberately dropped, not forwarded — see the doc comment above (`@typescript-eslint/no-unused-vars`'s own `^_` ignore pattern already covers these; only sonarjs's separate rule needs silencing).
  const { requestBody: _requestBody, requestHeaders: _requestHeaders, ...patch } = toWireExchange(exchange);
  return patch;
}
