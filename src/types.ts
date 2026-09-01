import type { IncomingHttpHeaders } from 'node:http';

/**
 * A single HTTP(S) request/response pair captured by the proxy.
 * This is the shape shared over the in-memory event bus, and later
 * (via the web dashboard) over the wire to consumers.
 */
export interface CapturedExchange {
  /** Unique id for this exchange, stable across the request/response lifecycle. */
  id: string;
  method: string;
  /** Fully-qualified URL, e.g. https://example.com/path?x=1 */
  url: string;
  host: string;
  isSSL: boolean;
  requestHeaders: IncomingHttpHeaders;
  requestBodySize: number;
  startedAt: number;

  statusCode?: number;
  statusMessage?: string;
  responseHeaders?: IncomingHttpHeaders;
  responseBodySize: number;
  finishedAt?: number;
  durationMs?: number;

  error?: string;
}

export interface ProxyErrorEvent {
  id?: string;
  errorKind: string;
  message: string;
}

/** Events published on the in-memory event bus. */
export interface DetourEvents {
  /** Fired once the client finished sending the request (headers + body). */
  request: (exchange: Readonly<CapturedExchange>) => void;
  /** Fired once the upstream response finished streaming back to the client. */
  response: (exchange: Readonly<CapturedExchange>) => void;
  /** Fired on proxy-level errors (connection resets, TLS failures, etc). */
  error: (event: ProxyErrorEvent) => void;
}
