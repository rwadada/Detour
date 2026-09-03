import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { BodyCapture } from '../domain/exchange/bodyCapture';
import type { CapturedExchange } from '../domain/exchange/types';
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
 */
export async function replayExchange(
  original: CapturedExchange,
  eventBus: ExchangeEventEmitter,
  requester: HttpRequester,
): Promise<void> {
  const startedAt = Date.now();
  const requestHeaders = stripHopByHopHeaders(original.requestHeaders);
  const requestBody = original.requestBody ? Buffer.from(original.requestBody, 'base64') : undefined;

  const exchange: CapturedExchange = {
    id: randomUUID(),
    method: original.method,
    url: original.url,
    host: original.host,
    isSSL: original.isSSL,
    protocol: 'HTTP/1.1',
    requestHeaders,
    requestBodySize: original.requestBodySize,
    requestBody: original.requestBody,
    requestBodyTruncated: original.requestBodyTruncated,
    startedAt,
    responseBodySize: 0,
  };
  eventBus.emit('request', exchange);

  try {
    const result = await requester.request({
      method: original.method,
      url: original.url,
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
