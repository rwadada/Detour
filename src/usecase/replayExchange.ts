import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { BodyCapture } from '../domain/exchange/bodyCapture';
import type { ReplayOverrides } from '../domain/dashboard/protocol';
import type { CapturedExchange, WireExchange } from '../domain/exchange/types';
import type { HttpRequester } from './ports/httpRequester';

/**
 * The one thing `replayExchange` needs from `DetourEventBus` — kept as a
 * narrow structural type here instead of importing `infra/eventBus`
 * directly, since a UseCase must never depend on infra (see root README /
 * issue #29's Clean Architecture layering). A real `DetourEventBus`
 * instance satisfies this without any adapter: its own `emit` is already a
 * superset of this shape.
 */
export interface ExchangeEventEmitter {
  emit(event: 'request' | 'response', exchange: CapturedExchange): void;
}

/** Headers a real outbound request must set for itself, not carry over verbatim from the original capture. */
const HOP_BY_HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);

function stripHopByHopHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) result[key] = value;
  }
  return result;
}

/** `host`/`isSSL` of the URL actually being sent to; the original's own when the URL wasn't edited (or can't be parsed — the request itself then fails and says why). */
function describeTarget(url: string, original: WireExchange): { host: string; isSSL: boolean } {
  if (url === original.url) return { host: original.host, isSSL: original.isSSL };
  try {
    const parsed = new URL(url);
    return { host: parsed.host, isSSL: parsed.protocol === 'https:' };
  } catch {
    return { host: original.host, isSSL: original.isSSL };
  }
}

/**
 * Re-sends a previously captured exchange for real (issue #19's Replay): a
 * fresh outbound HTTP(S) request built from the original method/url/
 * headers/body, going out directly from this process rather than back
 * through the MITM proxy — a request that already ran the interception/
 * rules gauntlet once doesn't need to run it again.
 *
 * The result is broadcast the same way live traffic is (`request` then
 * `response` on the event bus): `dashboardServer.ts`'s existing handlers
 * pick those up, add the exchange to the backlog, and push it to every
 * connected tab — a replay just shows up as a new row in the log table,
 * with no new frontend plumbing needed to display it.
 *
 * `overrides` (issue #214's Edit & Send) change method/URL/headers/body of
 * what is sent; whatever they leave out keeps the original's value. The new
 * exchange records `replayOf: original.id` either way, so the two can be
 * found and compared.
 */
export async function replayExchange(
  original: WireExchange,
  eventBus: ExchangeEventEmitter,
  requester: HttpRequester,
  overrides: ReplayOverrides = {},
): Promise<void> {
  const startedAt = Date.now();
  const method = overrides.method?.trim() || original.method;
  const url = overrides.url?.trim() || original.url;
  const target = describeTarget(url, original);
  const requestHeaders = stripHopByHopHeaders(overrides.headers ?? original.requestHeaders);
  // `original` is a `WireExchange` — the dashboard client only ever has a
  // base64-encoded body to send back (issue #165's Proposal B: the wire
  // format and `CapturedExchange`'s own in-memory `Buffer` representation
  // diverge on exactly this field). Decoded once, then reused below for
  // both the real outbound request and the freshly-built `CapturedExchange`
  // this replay broadcasts — never re-stored as the original base64 string.
  const bodyEdited = overrides.body !== undefined;
  const encodedBody = bodyEdited ? overrides.body : original.requestBody;
  const requestBody = encodedBody ? Buffer.from(encodedBody, 'base64') : undefined;

  const exchange: CapturedExchange = {
    id: randomUUID(),
    method,
    url,
    host: target.host,
    isSSL: target.isSSL,
    protocol: 'HTTP/1.1',
    requestHeaders,
    requestBodySize: bodyEdited ? (requestBody?.length ?? 0) : original.requestBodySize,
    requestBody,
    requestBodyTruncated: bodyEdited ? false : original.requestBodyTruncated,
    startedAt,
    responseBodySize: 0,
    replayOf: original.id,
  };
  eventBus.emit('request', exchange);

  try {
    const result = await requester.request({
      method,
      url,
      headers: requestHeaders,
      body: requestBody,
    });
    exchange.statusCode = result.statusCode;
    exchange.statusMessage = result.statusMessage;
    exchange.responseHeaders = result.headers;
    exchange.responseBodySize = result.body.length;
    BodyCapture.of(result.body).applyTo(exchange, 'response');
  } catch (err) {
    exchange.error = err instanceof Error ? err.message : String(err);
  }
  exchange.finishedAt = Date.now();
  exchange.durationMs = exchange.finishedAt - startedAt;
  eventBus.emit('response', exchange);
}
