import type http from 'node:http';
import type { ExchangeTiming, UpstreamCertificate } from '../../../domain/exchange/types';

/**
 * Type surface for `ProxyEngine` (issue #42's replacement for
 * `http-mitm-proxy`) — deliberately only the subset that
 * `proxyServer.ts`/`actionsRuntime.ts` actually consume (mirroring
 * `http-mitm-proxy`'s field names so those call sites needed no changes
 * beyond their import path), not a full re-implementation of the upstream
 * library's much larger public API.
 */

export type MaybeError = Error | null | undefined;
export type ErrorCallback = (error?: MaybeError, data?: unknown) => void;

export type OnRequestParams = (ctx: IContext, callback: ErrorCallback) => void;
type OnRequestDataCallback = (error?: MaybeError, chunk?: Buffer) => void;
export type OnRequestDataParams = (ctx: IContext, chunk: Buffer, callback: OnRequestDataCallback) => void;

export type OnConnectParams = (
  req: http.IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
  callback: ErrorCallback,
) => void;

export type OnErrorParams = (context: IContext | null, err?: MaybeError, errorKind?: string) => void;

export type OnWebsocketRequestParams = (ctx: IWebSocketContext, callback: ErrorCallback) => void;
type IWebSocketCallback = (err: MaybeError, message?: unknown, flags?: unknown) => void;
export type OnWebSocketFrameParams = (
  ctx: IWebSocketContext,
  type: 'message' | 'ping' | 'pong',
  fromServer: boolean,
  data: unknown,
  flags: unknown,
  callback: IWebSocketCallback,
) => void;
export type OnWebSocketCloseParams = (
  ctx: IWebSocketContext,
  code: number,
  message: Buffer,
  callback: ErrorCallback,
) => void;
export type OnWebSocketErrorParams = (ctx: IWebSocketContext, err: MaybeError) => void;

export interface IContext {
  readonly uuid: string;
  readonly isSSL: boolean;
  readonly clientToProxyRequest: http.IncomingMessage;
  readonly proxyToClientResponse: http.ServerResponse;
  proxyToServerRequest: http.ClientRequest | undefined;
  serverToProxyResponse: http.IncomingMessage | undefined;
  proxyToServerRequestOptions:
    | undefined
    | {
        method: string;
        path: string;
        host: string;
        port: string | number | null | undefined;
        headers: Record<string, string>;
        agent: http.Agent;
        /**
         * `ProxyEngineOptions.upstreamTls` (issue #160), set only for an SSL
         * request — a per-request option rather than baked into `agent`'s own
         * constructor, since `HttpsProxyAgent`/`SocksProxyAgent` (the
         * `--upstream-proxy` case) only ever apply a *constructor*-level
         * `ca`/`rejectUnauthorized`/`cert`/`key` to their own connection to
         * the upstream proxy itself, never to the CONNECT-tunneled
         * destination behind it — verified empirically. A per-request option
         * reaches both of those classes' own `connect()` methods (which use
         * it directly for the destination's `tls.connect()`) and a plain
         * `https.Agent`'s direct connection identically, so this applies the
         * same way whether or not `--upstream-proxy` is also in play.
         */
        ca?: string[];
        rejectUnauthorized?: boolean;
        cert?: string;
        key?: string;
      };
  responseContentPotentiallyModified: boolean;
  /**
   * DNS/TCP/TLS/TTFB timing for this exchange's proxy→upstream connection
   * (issue #140), filled in by `ProxyEngine.makeProxyToServerRequest` as
   * each phase completes. Undefined until (and unless) an upstream request
   * is actually dispatched — never set for a `mock`/blocked/request-phase-
   * aborted exchange. `transferMs` is left for the consumer to fill in
   * (see `responseHeadersAt`) once the body — possibly Throttled/rewritten
   * — actually finishes.
   */
  timing?: ExchangeTiming;
  /**
   * The upstream server's real TLS certificate (issue #160), filled in by
   * `ProxyEngine.trackSocketTiming` once the socket's handshake completes
   * (or, for a reused keep-alive socket, from that connection's cached
   * value). Undefined for plain HTTP, and for HTTPS whose handshake never
   * completed at all.
   */
  certificate?: UpstreamCertificate;
  /**
   * Absolute timestamp (ms since epoch) the response headers arrived, i.e.
   * right after `timing.ttfbMs` elapsed. Kept separate from `timing` (whose
   * fields are all durations, matching `CapturedExchange.timing`) so a
   * consumer can derive `timing.transferMs` as `finishedAt - responseHeadersAt`
   * once the response body finishes.
   */
  responseHeadersAt?: number;

  onRequestData(fn: OnRequestDataParams): IContext;
  onRequestEnd(fn: OnRequestParams): IContext;
  onResponseData(fn: OnRequestDataParams): IContext;
  onResponseEnd(fn: OnRequestParams): IContext;
}

export type IWebSocketContext = {
  readonly uuid: string;
  readonly isSSL: boolean;
  /** Set once the connection closes — `true` if the upstream server closed first, `false` if the client did. Undefined while still open. */
  closedByServer?: boolean;
  proxyToServerWebSocketOptions?: { url: string; headers: Record<string, string> };
};
