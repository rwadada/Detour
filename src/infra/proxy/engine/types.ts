import type http from 'node:http';

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
      };
  responseContentPotentiallyModified: boolean;

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
