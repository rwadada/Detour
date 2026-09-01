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
  /**
   * Captured request body, base64-encoded, capped at `MAX_CAPTURED_BODY_BYTES`
   * (see proxyServer.ts). Undefined when the body was empty or hasn't been
   * captured yet (e.g. a `request` event fired before the body finished).
   */
  requestBody?: string;
  /** True when `requestBodySize` exceeds what was actually captured in `requestBody`. */
  requestBodyTruncated?: boolean;
  startedAt: number;

  statusCode?: number;
  statusMessage?: string;
  responseHeaders?: IncomingHttpHeaders;
  responseBodySize: number;
  /** Captured response body, base64-encoded and capped — see `requestBody`. */
  responseBody?: string;
  /** True when `responseBodySize` exceeds what was actually captured in `responseBody`. */
  responseBodyTruncated?: boolean;
  finishedAt?: number;
  durationMs?: number;

  error?: string;
  /** Name of the rules.json rule that handled this exchange, if any. */
  ruleName?: string;
}

export interface ProxyErrorEvent {
  id?: string;
  errorKind: string;
  message: string;
}

export interface RulesReloadEvent {
  filePath: string;
  ruleCount: number;
}

/** Events published on the in-memory event bus. */
export interface DetourEvents {
  /** Fired once the client finished sending the request (headers + body). */
  request: (exchange: Readonly<CapturedExchange>) => void;
  /** Fired once the upstream response finished streaming back to the client. */
  response: (exchange: Readonly<CapturedExchange>) => void;
  /** Fired on proxy-level errors (connection resets, TLS failures, etc), and when a rules.json reload fails. */
  error: (event: ProxyErrorEvent) => void;
  /** Fired whenever rules.json is (re)loaded successfully. */
  rulesReloaded: (event: RulesReloadEvent) => void;
}
