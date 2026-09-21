import { describeUpstreamTlsError } from '../../../domain/exchange/tlsVerificationError';
import type { CapturedWebSocketConnection, WebSocketFrameRecord } from '../../../domain/exchange/types';
import { recordWebSocketFrame } from '../../../domain/exchange/webSocketCapture';
import type { DetourEventBus } from '../../eventBus';
import type {
  IWebSocketContext,
  OnWebSocketCloseParams,
  OnWebSocketErrorParams,
  OnWebSocketFrameParams,
  OnWebsocketRequestParams,
} from '../engine/types';

export interface WebSocketHandlersDeps {
  eventBus: DetourEventBus;
  /** Keyed by ctx.uuid — shared with the rest of the pipeline, not owned here. */
  wsConnections: Map<string, CapturedWebSocketConnection>;
}

/**
 * Extracts the target `ws://`/`wss://` URL and bare host from a WebSocket
 * context. `ctx.proxyToServerWebSocketOptions.url` is already fully
 * resolved by ProxyEngine by the time `onWebSocketConnection` fires (from
 * either the upgrade request's absolute URL, or its `Host` header — see
 * `handleWebSocketConnection` in engine/proxyEngine.ts), so there's no
 * host/port reassembly to do here.
 */
function resolveWsUrl(ctx: IWebSocketContext): { url: string; host: string } {
  const url = ctx.proxyToServerWebSocketOptions?.url ?? '';
  try {
    return { url, host: new URL(url).host };
  } catch {
    return { url, host: url };
  }
}

/**
 * Coerces a WebSocket frame's raw payload (as delivered by the `ws`
 * library — a `Buffer` in the common case, but its types also allow
 * `ArrayBuffer`/`Buffer[]` depending on client options) into a plain
 * `Buffer` for capture.
 */
function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  return Buffer.from(String(data ?? ''), 'utf8');
}

/**
 * WebSocket support (issue #17): ProxyEngine relays `ws://`/`wss://`
 * traffic transparently on its own (a `wss://` tunnel only ever reaches
 * these hooks once intercept has already MITM-decrypted it — see
 * `createInterceptOffConnectHandler`; a passthrough tunnel's WS frames
 * are just opaque encrypted bytes to us like the rest of its traffic), so
 * these four hooks are purely observational: they build up a
 * `CapturedWebSocketConnection` per connection and publish it on the
 * event bus, mirroring `request`/`response` for HTTP exchanges. None of
 * them touch `data`/`flags` before calling back, so the actual proxied
 * traffic is never altered by recording it.
 */
export function createWebSocketHandlers(deps: WebSocketHandlersDeps): {
  onConnection: OnWebsocketRequestParams;
  onFrame: OnWebSocketFrameParams;
  onClose: OnWebSocketCloseParams;
  onError: OnWebSocketErrorParams;
} {
  const { eventBus, wsConnections } = deps;

  const onConnection: OnWebsocketRequestParams = (ctx, callback) => {
    const { url, host } = resolveWsUrl(ctx);
    const connection: CapturedWebSocketConnection = {
      id: ctx.uuid,
      url,
      host,
      isSSL: ctx.isSSL,
      // `sec-websocket-*` headers are handshake plumbing (key/version/
      // extensions), not application data — already stripped out by
      // ProxyEngine when it built this options object, so what's left is
      // exactly what's worth showing in a debug dump.
      requestHeaders: { ...(ctx.proxyToServerWebSocketOptions?.headers as Record<string, string> | undefined) },
      openedAt: Date.now(),
      frames: [],
      frameCount: 0,
      framesTruncated: false,
    };
    wsConnections.set(ctx.uuid, connection);
    eventBus.emit('wsOpen', connection);
    callback();
  };

  const onFrame: OnWebSocketFrameParams = (ctx, type, fromServer, data, flags, callback) => {
    const connection = wsConnections.get(ctx.uuid);
    if (connection) {
      recordWebSocketFrame(connection, {
        type: type as WebSocketFrameRecord['type'],
        direction: fromServer ? 'toClient' : 'toServer',
        // For a `message` frame, ProxyEngine forwards the underlying `ws`
        // library's `isBinary` event argument through as `flags` (despite
        // the type declaring it `unknown` — see `relayFrame` in
        // engine/proxyEngine.ts); `ping`/`pong` frames carry no such flag.
        binary: typeof flags === 'boolean' ? flags : false,
        payload: toBuffer(data),
        at: Date.now(),
      });
      eventBus.emit('wsFrame', connection);
    }
    callback(null, data, flags);
  };

  const onClose: OnWebSocketCloseParams = (ctx, code, message, callback) => {
    const connection = wsConnections.get(ctx.uuid);
    if (connection) {
      connection.closedAt = Date.now();
      connection.durationMs = connection.closedAt - connection.openedAt;
      connection.closeCode = typeof code === 'number' ? code : undefined;
      connection.closeReason = Buffer.isBuffer(message) ? message.toString('utf8') : undefined;
      connection.closedByServer = ctx.closedByServer;
      wsConnections.delete(ctx.uuid);
      eventBus.emit('wsClose', connection);
    }
    // `null`, not omitted: this is the same `ErrorCallback` used elsewhere
    // in the pipeline (whose `error` param is in fact optional), but a
    // close is never itself an error, so spelling out "no error" here reads
    // clearer than an empty call would.
    callback(null);
  };

  const onError: OnWebSocketErrorParams = (ctx, err) => {
    // A wss:// upstream TLS-verification failure (issue #160) gets the same
    // specific, actionable message the HTTP(S) path already gets via
    // `proxyErrorHandler.ts` — `describeUpstreamTlsError` recognizes it by
    // `err.code` regardless of connection type — instead of a raw Node
    // error message like "self-signed certificate".
    const message = describeUpstreamTlsError(err) ?? err?.message ?? 'unknown websocket error';
    // A connection already closed (and thus already reported via `wsClose`
    // above) is removed from `wsConnections`, so a follow-up error on its
    // other leg — see ProxyEngine's own close/error cross-signaling in
    // `wsClose`/`wsError` (engine/proxyEngine.ts) — is a harmless no-op
    // here rather than a second `wsClose` for the same connection.
    const connection = wsConnections.get(ctx.uuid);
    if (connection) {
      connection.error = message;
      connection.closedAt = Date.now();
      connection.durationMs = connection.closedAt - connection.openedAt;
      wsConnections.delete(ctx.uuid);
      eventBus.emit('wsClose', connection);
    }
    eventBus.emit('error', {
      id: ctx.uuid,
      errorKind: 'WEBSOCKET_ERROR',
      message,
    });
  };

  return { onConnection, onFrame, onClose, onError };
}
