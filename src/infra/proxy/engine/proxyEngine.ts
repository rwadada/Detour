import crypto from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { CertAuthority } from './certAuthority';
import type {
  ErrorCallback,
  IContext,
  IWebSocketContext,
  MaybeError,
  OnConnectParams,
  OnErrorParams,
  OnRequestDataParams,
  OnRequestParams,
  OnWebSocketCloseParams,
  OnWebSocketErrorParams,
  OnWebSocketFrameParams,
  OnWebsocketRequestParams,
} from './types';

export interface ProxyEngineOptions {
  port: number;
  host: string;
  sslCaDir: string;
  /** @default true */
  http2?: boolean;
}

/** A request/response pair's actual mutable hook lists — `IContext`'s public surface plus the bookkeeping `ProxyEngine` needs internally, never exposed to consumers. */
interface Context extends IContext {
  onRequestDataHandlers: OnRequestDataParams[];
  onRequestEndHandlers: OnRequestParams[];
  onResponseDataHandlers: OnRequestDataParams[];
  onResponseEndHandlers: OnRequestParams[];
}

interface WsContext extends IWebSocketContext {
  clientWs?: WebSocket;
  serverWs?: WebSocket;
}

/** `public-key-pins*` is meaningless coming from a MITM'd connection (the client already trusts our substituted cert) and actively harmful to forward — a real browser honoring it would pin against a cert chain it will never see again once Detour stops intercepting. */
function filterAndCanonizeHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const key in headers) {
    if (/^public-key-pins/i.test(key)) continue;
    result[key.trim()] = headers[key];
  }
  return result;
}

function isHttp2(req: IncomingMessage): boolean {
  return req.httpVersionMajor === 2;
}

/** `ws`'s public types don't expose the underlying socket, but every real implementation has one — accessed here without `any` via a narrow structural cast. */
function underlyingSocket(ws: WebSocket): net.Socket | undefined {
  return (ws as unknown as { _socket?: net.Socket })._socket;
}

function flattenHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

/** Runs `handlers` in series against `ctx`, short-circuiting on the first error — the `async.forEach`-with-one-registration-in-practice pattern `http-mitm-proxy` used, minus the parallel-execution semantics that never actually mattered here (see proxyEngine.ts's module doc comment). */
function runChain<T>(
  handlers: Array<(ctx: T, cb: ErrorCallback) => void>,
  ctx: T,
  done: (err?: MaybeError) => void,
): void {
  let i = 0;
  const next = (err?: MaybeError): void => {
    if (err) {
      done(err);
      return;
    }
    if (i >= handlers.length) {
      done(null);
      return;
    }
    const fn = handlers[i++]!;
    fn(ctx, next);
  };
  next();
}

/** Same as `runChain`, but threads a `Buffer` through each handler (`onRequestData`/`onResponseData`'s shape), each one free to replace it before the next sees it. */
function runDataChain(
  handlers: OnRequestDataParams[],
  ctx: IContext,
  chunk: Buffer,
  done: (err: MaybeError, chunk: Buffer) => void,
): void {
  let i = 0;
  let current = chunk;
  const next = (err?: MaybeError, newChunk?: Buffer): void => {
    if (err) {
      done(err, current);
      return;
    }
    if (newChunk !== undefined) current = newChunk;
    if (i >= handlers.length) {
      done(null, current);
      return;
    }
    const fn = handlers[i++]!;
    fn(ctx, current, next);
  };
  next();
}

/**
 * A from-scratch MITM proxy core (issue #42), replacing `http-mitm-proxy`:
 * intercepts CONNECT tunnels via a single internal TLS/HTTP2 server whose
 * `SNICallback` mints a CA-signed leaf certificate per host on the fly
 * (`CertAuthority`), and forwards HTTP/1.1 and HTTP/2 requests upstream via
 * plain `node:http`/`node:https`.
 *
 * Exposes the same registration methods (`onConnect`/`onRequest`/
 * `onResponse`/`onResponseHeaders`/`onWebSocket*`/`onError`) and per-exchange
 * `ctx` shape (`onRequestData`/`onRequestEnd`/`onResponseData`/
 * `onResponseEnd`) that `proxyServer.ts`'s rule engine glue was already
 * written against, so that logic — mock/breakpoint/script/route/rewrite
 * dispatch, Throttle, Block Hosts, Focus — needed no changes beyond its
 * import path.
 */
export class ProxyEngine {
  private readonly onConnectHandlers: OnConnectParams[] = [];
  private readonly onRequestHandlers: OnRequestParams[] = [];
  private readonly onResponseHandlers: OnRequestParams[] = [];
  private readonly onResponseHeadersHandlers: OnRequestParams[] = [];
  private readonly onWebSocketConnectionHandlers: OnWebsocketRequestParams[] = [];
  private readonly onWebSocketFrameHandlers: OnWebSocketFrameParams[] = [];
  private readonly onWebSocketCloseHandlers: OnWebSocketCloseParams[] = [];
  private readonly onWebSocketErrorHandlers: OnWebSocketErrorParams[] = [];
  private readonly onErrorHandlers: OnErrorParams[] = [];

  private readonly httpAgent = new http.Agent({ keepAlive: false });
  private readonly httpsAgent = new https.Agent({ keepAlive: false });

  private httpServer: http.Server | undefined;
  private tlsServer: https.Server | http2.Http2SecureServer | undefined;

  ca!: CertAuthority;
  httpPort = 0;

  onConnect(fn: OnConnectParams): this {
    this.onConnectHandlers.push(fn);
    return this;
  }

  onRequest(fn: OnRequestParams): this {
    this.onRequestHandlers.push(fn);
    return this;
  }

  onResponse(fn: OnRequestParams): this {
    this.onResponseHandlers.push(fn);
    return this;
  }

  onResponseHeaders(fn: OnRequestParams): this {
    this.onResponseHeadersHandlers.push(fn);
    return this;
  }

  onWebSocketConnection(fn: OnWebsocketRequestParams): this {
    this.onWebSocketConnectionHandlers.push(fn);
    return this;
  }

  onWebSocketFrame(fn: OnWebSocketFrameParams): this {
    this.onWebSocketFrameHandlers.push(fn);
    return this;
  }

  onWebSocketClose(fn: OnWebSocketCloseParams): this {
    this.onWebSocketCloseHandlers.push(fn);
    return this;
  }

  onWebSocketError(fn: OnWebSocketErrorParams): this {
    this.onWebSocketErrorHandlers.push(fn);
    return this;
  }

  onError(fn: OnErrorParams): this {
    this.onErrorHandlers.push(fn);
    return this;
  }

  /** Parses a proxied request's target host/port: absolute-form (`http://host/path`, rewriting `req.url` down to the bare path same as the client never sent the prefix), else `Host` (HTTP/1.1) or `:authority` (HTTP/2 has no `Host` header — Node's http2 compatibility layer doesn't alias it in). */
  static parseHostAndPort(
    req: IncomingMessage,
    defaultPort?: number,
  ): { host: string; port: number | undefined } | null {
    const url = req.url ?? '';
    const absoluteMatch = url.match(/^http:\/\/([^/]+)(.*)/);
    if (absoluteMatch) {
      req.url = absoluteMatch[2] || '/';
      return ProxyEngine.parseHost(absoluteMatch[1]!, defaultPort);
    }
    const authority = req.headers.host ?? (req.headers[':authority'] as string | undefined);
    if (authority) return ProxyEngine.parseHost(authority, defaultPort);
    return null;
  }

  static parseHost(hostString: string, defaultPort?: number): { host: string; port: number | undefined } {
    // A bracketed IPv6 literal (`[::1]`, `[::1]:8443`) is RFC 3986's own way
    // to pair one with an explicit port — required precisely because a bare
    // "::1:8443" would otherwise be ambiguous with a literal ending in
    // ":8443". Unwrap the brackets and read the port (if any) from after them.
    const bracketed = hostString.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracketed) return { host: bracketed[1]!, port: bracketed[2] ? Number(bracketed[2]) : defaultPort };
    // More than one colon with no brackets is an unbracketed IPv6 literal
    // (e.g. a bare "::1", as a Host header without a port) — per RFC 3986 a
    // client pairing one with an explicit port must bracket it, so treat the
    // whole string as the host rather than mis-splitting on the last colon.
    if ((hostString.match(/:/g) ?? []).length > 1) return { host: hostString, port: defaultPort };
    const lastColon = hostString.lastIndexOf(':');
    if (lastColon === -1) return { host: hostString, port: defaultPort };
    return { host: hostString.slice(0, lastColon), port: Number(hostString.slice(lastColon + 1)) };
  }

  async listen(options: ProxyEngineOptions, callback: ErrorCallback = () => undefined): Promise<void> {
    try {
      this.ca = CertAuthority.load(options.sslCaDir);

      this.tlsServer = this.createInternalTlsServer(options.http2 ?? true);
      await listenAsync(this.tlsServer, 0, '127.0.0.1');
      const internalPort = (this.tlsServer.address() as net.AddressInfo).port;

      this.httpServer = http.createServer();
      this.httpServer.on('connect', (req, socket, head) =>
        this.handleConnect(req, socket as Duplex, head, internalPort),
      );
      this.httpServer.on('request', (req, res) => this.handleRequest(req, res, false));
      this.httpServer.on('error', (err) => this.emitError('HTTP_SERVER_ERROR', null, err));
      this.attachWebSocketServer(this.httpServer, false);

      await listenAsync(this.httpServer, options.port, options.host);
      this.httpPort = (this.httpServer.address() as net.AddressInfo).port;
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  close(): void {
    this.httpServer?.close();
    this.tlsServer?.close();
  }

  private createInternalTlsServer(http2Enabled: boolean): https.Server | http2.Http2SecureServer {
    const defaultKeyCert = this.ca.getDefaultKeyCert();
    const SNICallback = (
      servername: string,
      cb: (err: Error | null, ctx?: import('node:tls').SecureContext) => void,
    ) => {
      try {
        cb(null, this.ca.getSecureContext(servername || 'localhost'));
      } catch (err) {
        cb(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const server = http2Enabled
      ? http2.createSecureServer({
          ...defaultKeyCert,
          allowHTTP1: true,
          ALPNProtocols: ['h2', 'http/1.1'],
          SNICallback,
        })
      : https.createServer({ ...defaultKeyCert, ALPNProtocols: ['http/1.1'], SNICallback });

    server.on('request', (req, res) => this.handleRequest(req as IncomingMessage, res as ServerResponse, true));
    server.on('error', (err) => this.emitError('HTTPS_SERVER_ERROR', null, err));
    server.on('clientError', (err) => this.emitError('HTTPS_CLIENT_ERROR', null, err));
    this.attachWebSocketServer(server, true);
    return server;
  }

  /** Runs the registered `onConnect` handlers (Block Hosts / Focus / passthrough dispatch — see `proxyServer.ts`); if every one calls back without handling the tunnel itself, MITMs it by bridging the raw client socket into the internal TLS/HTTP2 server. */
  private handleConnect(req: IncomingMessage, socket: Duplex, head: Buffer, internalPort: number): void {
    socket.on('error', (err) => this.onSocketError('CLIENT_TO_PROXY_SOCKET', err));

    let i = 0;
    const next = (err?: MaybeError): void => {
      if (err) {
        this.emitError('ON_CONNECT_ERROR', null, err);
        return;
      }
      if (i >= this.onConnectHandlers.length) {
        this.establishMitmTunnel(socket, head, internalPort);
        return;
      }
      const fn = this.onConnectHandlers[i++]!;
      fn(req, socket, head, next);
    };
    next();
  }

  private establishMitmTunnel(socket: Duplex, head: Buffer, internalPort: number): void {
    if (socket.destroyed) return;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const upstream = net.connect({ port: internalPort, host: '127.0.0.1' }, () => {
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', (err) => this.onSocketError('PROXY_TO_PROXY_SOCKET', err));
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
  }

  private onSocketError(kind: string, err: NodeJS.ErrnoException): void {
    if (err.code === 'ECONNRESET') return;
    this.emitError(`${kind}_ERROR`, null, err);
  }

  private buildContext(req: IncomingMessage, res: ServerResponse, isSSL: boolean): Context {
    return {
      uuid: crypto.randomUUID(),
      isSSL,
      clientToProxyRequest: req,
      proxyToClientResponse: res,
      proxyToServerRequest: undefined,
      serverToProxyResponse: undefined,
      proxyToServerRequestOptions: undefined,
      responseContentPotentiallyModified: false,
      onRequestDataHandlers: [],
      onRequestEndHandlers: [],
      onResponseDataHandlers: [],
      onResponseEndHandlers: [],
      onRequestData(fn) {
        this.onRequestDataHandlers.push(fn);
        return this;
      },
      onRequestEnd(fn) {
        this.onRequestEndHandlers.push(fn);
        return this;
      },
      onResponseData(fn) {
        this.onResponseDataHandlers.push(fn);
        this.responseContentPotentiallyModified = true;
        return this;
      },
      onResponseEnd(fn) {
        this.onResponseEndHandlers.push(fn);
        return this;
      },
    };
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse, isSSL: boolean): void {
    const ctx = this.buildContext(req, res, isSSL);
    req.on('error', (err) => this.emitError('CLIENT_TO_PROXY_REQUEST_ERROR', ctx, err));
    res.on('error', (err) => this.emitError('PROXY_TO_CLIENT_RESPONSE_ERROR', ctx, err));
    req.pause();

    const hostPort = ProxyEngine.parseHostAndPort(req, isSSL ? 443 : 80);
    if (!hostPort) {
      req.resume();
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('Bad request: Host missing...', 'utf-8');
      return;
    }

    const headers: Record<string, string> = {};
    for (const key in req.headers) {
      // Proxy-only and HTTP/2 pseudo-headers (`:path`, `:authority`, …)
      // carry nothing the real upstream request needs — it always goes out
      // as plain HTTP/1.1 (built from `host`/`port`/`path` below), and a
      // literal `:`-prefixed header would crash `http(s).request()`.
      if (!/^proxy-/i.test(key) && !key.startsWith(':')) headers[key] = flattenHeaderValue(req.headers[key]);
    }

    ctx.proxyToServerRequestOptions = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      host: hostPort.host,
      port: hostPort.port,
      headers,
      agent: isSSL ? this.httpsAgent : this.httpAgent,
    };

    runChain(this.onRequestHandlers, ctx, (err) => {
      if (err) {
        this.emitError('ON_REQUEST_ERROR', ctx, err);
        return;
      }
      this.makeProxyToServerRequest(ctx);
    });
  }

  private makeProxyToServerRequest(ctx: Context): void {
    const opts = ctx.proxyToServerRequestOptions!;
    const transport = ctx.isSSL ? https : http;
    const upstreamReq = transport.request(opts, (upstreamRes) => this.onUpstreamResponse(ctx, upstreamRes));
    ctx.proxyToServerRequest = upstreamReq;
    upstreamReq.on('error', (err) => this.emitError('PROXY_TO_SERVER_REQUEST_ERROR', ctx, err));
    this.pumpRequestBody(ctx);
  }

  /**
   * Streams the client's request body upstream chunk-by-chunk through
   * `onRequestData` — see `pumpChunks`'s doc comment for the mechanics.
   *
   * A `mock`/`breakpoint`/`script` rule (see `proxyServer.ts`) drains the
   * client's body directly, *before* this ever runs, then registers its own
   * `onRequestData`/`onRequestEnd` that only replay an already-known final
   * body — by the time `callback()` unblocks this method, `req.complete` is
   * already `true` and no further `'data'`/`'end'` will ever fire, so
   * `pumpChunks` treats that as an immediate, no-listeners finish instead.
   */
  private pumpRequestBody(ctx: Context): void {
    const client = ctx.clientToProxyRequest;
    const upstream = ctx.proxyToServerRequest!;
    this.pumpChunks({
      ctx,
      source: client,
      handlers: ctx.onRequestDataHandlers,
      dataErrorKind: 'ON_REQUEST_DATA_ERROR',
      write: (chunk) => upstream.write(chunk),
      onDrain: (cb) => upstream.once('drain', cb),
      finish: () => {
        runChain(ctx.onRequestEndHandlers, ctx, (err) => {
          if (err) {
            this.emitError('ON_REQUEST_END_ERROR', ctx, err);
            return;
          }
          upstream.end();
        });
      },
      onAbort: (err) => {
        // The client is gone — sending the rest of an already-started
        // upstream request would just hang it waiting for a body that will
        // never arrive.
        upstream.destroy();
        this.emitError('CLIENT_TO_PROXY_REQUEST_ERROR', ctx, err);
      },
    });
    client.resume();
  }

  /**
   * Streams `source`'s data into `write`/`onDrain` chunk-by-chunk through
   * `handlers` (`onRequestData`/`onResponseData`'s shape), honoring real
   * backpressure (pausing `source` while the destination is unable to keep
   * up) and a genuine per-chunk delayed callback — the chunk-level
   * throttling/streaming `http-mitm-proxy` couldn't do (see issue #42 and
   * `throttleTransform.ts`'s doc comment). Shared by `pumpRequestBody`/
   * `pumpResponseBody`, identical apart from which stream is the source and
   * which hook/error-kind/finish/abort behavior applies.
   *
   * `readableEnded` (not `.complete`, which the HTTP parser can flip before
   * the stream has actually been drained — see e.g. `handleRequestBreakpoint`
   * in proxyServer.ts) is the precise signal that `source` already fully
   * emitted 'end' and no further `'data'`/`'end'`/`'aborted'`/`'close'` will
   * ever come, in which case `finish` runs immediately with no listeners
   * attached.
   *
   * `ended`/`processing` below track whether `source`'s 'end' arrived while
   * a chunk was still being processed (e.g. delayed by Throttle's
   * `setTimeout`) — if it did, `finish` must NOT run until that chunk's
   * callback actually resolves and its data is written, or the tail of the
   * body would be silently dropped.
   *
   * A connection that drops mid-body (client disconnects, or the upstream
   * server's own connection resets) never fires 'end' at all — `IncomingMessage`
   * emits `'aborted'` (still supported, if legacy, as of the Node versions
   * `engines.node` targets) and/or `'close'` instead, either of which would
   * otherwise leave this pump waiting forever, hanging the other leg and
   * leaking the exchange (never reaching `finish`, so `proxyServer.ts` never
   * gets to publish `'response'`/clean up `inFlight`/resolve a breakpoint for
   * it). `settled` guards `onAbort` from running twice (once from
   * `'aborted'`, again from the `'close'` that follows it) and from firing
   * at all once the body genuinely completed normally.
   */
  private pumpChunks(opts: {
    ctx: Context;
    source: IncomingMessage;
    handlers: OnRequestDataParams[];
    dataErrorKind: string;
    write: (chunk: Buffer) => boolean;
    onDrain: (cb: () => void) => void;
    finish: () => void;
    onAbort: (err: Error) => void;
  }): void {
    const { ctx, source, handlers, dataErrorKind, write, onDrain, finish, onAbort } = opts;

    if (source.readableEnded) {
      finish();
      return;
    }

    let ended = false;
    let processing = false;
    let settled = false;
    const maybeFinish = (): void => {
      if (ended && !processing && !settled) finish();
    };

    const onData = (chunk: Buffer): void => {
      source.pause();
      processing = true;
      runDataChain(handlers, ctx, chunk, (err, newChunk) => {
        processing = false;
        if (settled) return; // aborted while this chunk was in flight — nothing more to do.
        if (err) {
          this.emitError(dataErrorKind, ctx, err);
          return;
        }
        const afterWrite = (): void => {
          if (ended) maybeFinish();
          else source.resume();
        };
        if (newChunk.length === 0 || write(newChunk)) afterWrite();
        else onDrain(afterWrite);
      });
    };
    const abort = (err: Error): void => {
      if (settled) return;
      settled = true;
      source.off('data', onData);
      onAbort(err);
    };
    source.on('data', onData);
    source.once('end', () => {
      source.off('data', onData);
      ended = true;
      maybeFinish();
    });
    source.once('aborted', () => abort(new Error('connection aborted before the body finished')));
    // 'close' always follows a normal 'end' too — only treat it as an abort
    // if the body never actually finished.
    source.once('close', () => {
      if (!ended) abort(new Error('connection closed before the body finished'));
    });
  }

  private onUpstreamResponse(ctx: Context, upstreamRes: IncomingMessage): void {
    upstreamRes.on('error', (err) => this.emitError('SERVER_TO_PROXY_RESPONSE_ERROR', ctx, err));
    upstreamRes.pause();
    ctx.serverToProxyResponse = upstreamRes;

    runChain(this.onResponseHandlers, ctx, (err) => {
      if (err) {
        this.emitError('ON_RESPONSE_ERROR', ctx, err);
        return;
      }
      const res = ctx.serverToProxyResponse!;
      const clientIsHttp2 = isHttp2(ctx.clientToProxyRequest);

      // A body that's read chunk-by-chunk via `onResponseData` (registered
      // unconditionally by `proxyServer.ts`, to size/capture every
      // exchange) may leave upstream's own `content-length` framing wrong —
      // e.g. Throttle or a `rewrite` rule changing byte counts — so once
      // that's in play, the stale value must never reach the client.
      // HTTP/1.1 re-frames as chunked; HTTP/2 has no `transfer-encoding`
      // (framing is native to the protocol, and the header is forbidden —
      // see the `clientIsHttp2` cleanup below), but it does carry
      // `content-length` as an ordinary header, and RFC 9113 §8.1.1 makes a
      // response whose DATA frames don't match it malformed — so h2 still
      // needs the stale header dropped, just without the h1-only re-framing.
      if (ctx.responseContentPotentiallyModified) {
        delete res.headers['content-length'];
        if (!clientIsHttp2) res.headers['transfer-encoding'] = 'chunked';
      }
      // Detour never keeps upstream/downstream connections alive across
      // requests (`keepAlive: false` on both agents above) — telling an
      // HTTP/1.1 client to close matches what actually happens.
      if (!clientIsHttp2) res.headers['connection'] = 'close';

      runChain(this.onResponseHeadersHandlers, ctx, (err2) => {
        if (err2) {
          this.emitError('ON_RESPONSEHEADERS_ERROR', ctx, err2);
          return;
        }
        if (clientIsHttp2) {
          // HTTP/1-only connection-specific headers — Node's h2 compat
          // `writeHead` throws if any of these are present, whether we set
          // them ourselves above or the real upstream server sent its own.
          delete res.headers['connection'];
          delete res.headers['transfer-encoding'];
          delete res.headers['keep-alive'];
          delete res.headers['proxy-connection'];
          delete res.headers['upgrade'];
        }
        ctx.proxyToClientResponse.writeHead(res.statusCode ?? 200, filterAndCanonizeHeaders(res.headers));
        this.pumpResponseBody(ctx);
        res.resume();
      });
    });
  }

  /** Mirrors `pumpRequestBody` for the downstream leg (see `pumpChunks`'s doc comment) — the same already-drained special case applies here for a response-phase `breakpoint`/`script` rule, via `proxyServer.ts`'s `handleResponseBreakpoint`/`handleScriptResponseHook`. */
  private pumpResponseBody(ctx: Context): void {
    const upstream = ctx.serverToProxyResponse!;
    const client = ctx.proxyToClientResponse;
    this.pumpChunks({
      ctx,
      source: upstream,
      handlers: ctx.onResponseDataHandlers,
      dataErrorKind: 'ON_RESPONSE_DATA_ERROR',
      write: (chunk) => client.write(chunk),
      onDrain: (cb) => client.once('drain', cb),
      finish: () => {
        runChain(ctx.onResponseEndHandlers, ctx, (err) => {
          if (err) {
            this.emitError('ON_RESPONSE_END_ERROR', ctx, err);
            return;
          }
          client.end();
        });
      },
      onAbort: (err) => {
        // Upstream dropped mid-response — headers are already flushed to the
        // client by this point, so there's no clean status to fall back to;
        // emitError's own guards (`!headersSent`/`!writableEnded`) make this
        // just tear the connection down instead.
        this.emitError('SERVER_TO_PROXY_RESPONSE_ERROR', ctx, err);
      },
    });
  }

  private emitError(kind: string, ctx: IContext | null, err: Error): void {
    if (ctx) {
      const res = ctx.proxyToClientResponse;
      try {
        if (!res.headersSent) {
          if (isHttp2(ctx.clientToProxyRequest)) res.writeHead(504);
          else res.writeHead(504, 'Proxy Error');
        }
        if (!res.writableEnded) res.end(`${kind}: ${err}`, 'utf8');
      } catch (writeErr) {
        // `!headersSent`/`!writableEnded` above guard against writing
        // twice, but not against the client's connection itself already
        // being gone by the time an abort/error handler gets here — an
        // HTTP/2 stream in that state throws synchronously
        // (ERR_HTTP2_INVALID_STREAM: "The stream has been destroyed") from
        // `writeHead`/`end` rather than just no-op-ing the way an
        // already-closed HTTP/1 socket does, and nothing upstream of this
        // method catches it — an uncaught exception here previously took
        // the whole process down over what's ultimately a client that
        // already left and was never going to see this response anyway.
        //
        // Deliberately not narrowed to just that one error code: an
        // already-gone client can surface as more than one shape depending
        // on exactly when/how it left, and guessing at an exhaustive list
        // risks leaving the process just as exposed to whichever one isn't
        // on it. Still reported to the same `onErrorHandlers` any other
        // proxy error goes through (as its own `kind`, and with `ctx: null`
        // — this is a failure to even report `kind` above, not `kind`
        // itself, and passing the real `ctx` here would double the
        // per-request cleanup `proxyServer.ts`'s own `onError` handler does
        // for it) so a write failure that turns out *not* to be one of
        // these benign already-gone-client cases still shows up in
        // logging/telemetry instead of silently vanishing.
        const reportedErr = writeErr instanceof Error ? writeErr : new Error(String(writeErr));
        for (const handler of this.onErrorHandlers) handler(null, reportedErr, 'EMIT_ERROR_RESPONSE_WRITE_FAILED');
      }
    }
    for (const handler of this.onErrorHandlers) handler(ctx, err, kind);
  }

  // ---- WebSocket relay (issue #17) ----

  private attachWebSocketServer(server: http.Server | https.Server | http2.Http2SecureServer, isSSL: boolean): void {
    const wss = new WebSocketServer({ server: server as http.Server });
    wss.on('error', (err) => this.emitError('HTTP_SERVER_ERROR', null, err));
    wss.on('connection', (ws, upgradeReq) => this.handleWebSocketConnection(ws, upgradeReq, isSSL));
  }

  private handleWebSocketConnection(clientWs: WebSocket, upgradeReq: IncomingMessage, isSSL: boolean): void {
    // Set immediately (not just once `connectUpstreamWebSocket` runs) so
    // that a rejection from `onWebSocketConnectionHandlers` below — which
    // skips `connectUpstreamWebSocket` entirely — still has a `clientWs` to
    // resume/close; otherwise the socket paused just below would stay
    // paused forever.
    const ctx: WsContext = { uuid: crypto.randomUUID(), isSSL, clientWs };
    underlyingSocket(clientWs)?.pause();

    const reqUrl = upgradeReq.url ?? '';
    let url: string;
    if (reqUrl === '' || reqUrl.startsWith('/')) {
      const hostPort = ProxyEngine.parseHostAndPort(upgradeReq);
      const port = hostPort?.port ? `:${hostPort.port}` : '';
      url = `${isSSL ? 'wss' : 'ws'}://${hostPort?.host ?? ''}${port}${reqUrl}`;
    } else {
      url = reqUrl;
    }
    const headers: Record<string, string> = {};
    for (const key in upgradeReq.headers) {
      if (!key.toLowerCase().startsWith('sec-websocket')) headers[key] = flattenHeaderValue(upgradeReq.headers[key]);
    }
    ctx.proxyToServerWebSocketOptions = { url, headers };

    runChain(this.onWebSocketConnectionHandlers, ctx, (err) => {
      if (err) {
        this.wsError(ctx, err);
        // No `serverWs` exists yet for `closeStillOpenLeg` (called from
        // `wsError`) to cross-signal against — resume and close the client
        // side directly instead, or it stays paused forever.
        underlyingSocket(clientWs)?.resume();
        clientWs.close();
        return;
      }
      this.connectUpstreamWebSocket(ctx, clientWs);
    });
  }

  private connectUpstreamWebSocket(ctx: WsContext, clientWs: WebSocket): void {
    const { url, headers } = ctx.proxyToServerWebSocketOptions!;
    const serverWs = new WebSocket(url, { headers });
    ctx.serverWs = serverWs;

    clientWs.on('message', (data, isBinary) => this.relayFrame(ctx, 'message', false, data, isBinary));
    clientWs.on('ping', (data) => this.relayFrame(ctx, 'ping', false, data, undefined));
    clientWs.on('pong', (data) => this.relayFrame(ctx, 'pong', false, data, undefined));
    clientWs.on('error', (err) => this.wsError(ctx, err));
    clientWs.on('close', (code, reason) => this.wsClose(ctx, false, code, reason));

    serverWs.on('open', () => underlyingSocket(clientWs)?.resume());
    serverWs.on('message', (data, isBinary) => this.relayFrame(ctx, 'message', true, data, isBinary));
    serverWs.on('ping', (data) => this.relayFrame(ctx, 'ping', true, data, undefined));
    serverWs.on('pong', (data) => this.relayFrame(ctx, 'pong', true, data, undefined));
    serverWs.on('error', (err) => this.wsError(ctx, err));
    serverWs.on('close', (code, reason) => this.wsClose(ctx, true, code, reason));
  }

  private relayFrame(
    ctx: WsContext,
    type: 'message' | 'ping' | 'pong',
    fromServer: boolean,
    data: unknown,
    flags: unknown,
  ): void {
    runChain(
      this.onWebSocketFrameHandlers.map(
        (fn) => (c: WsContext, cb: ErrorCallback) =>
          fn(c, type, fromServer, data, flags, (err, newData, newFlags) => {
            data = newData;
            flags = newFlags;
            cb(err);
          }),
      ),
      ctx,
      (err) => {
        if (err) {
          this.wsError(ctx, err);
          return;
        }
        const dest = fromServer ? ctx.clientWs! : ctx.serverWs!;
        if (dest.readyState !== WebSocket.OPEN) {
          this.wsError(
            ctx,
            new Error(
              `Cannot send ${type} because ${fromServer ? 'clientToProxy' : 'proxyToServer'} socket isn't open`,
            ),
          );
          return;
        }
        if (type === 'message') dest.send(data as WebSocket.RawData, { binary: flags as boolean });
        else if (type === 'ping') dest.ping(data as Buffer, flags as boolean);
        else dest.pong(data as Buffer, flags as boolean);
      },
    );
  }

  private wsClose(ctx: WsContext, closedByServer: boolean, code: number, message: Buffer): void {
    if (ctx.closedByServer !== undefined) return; // already reported (the other leg's close/error fired first)
    ctx.closedByServer = closedByServer;
    runChain(
      this.onWebSocketCloseHandlers.map((fn) => (c: WsContext, cb: ErrorCallback) => fn(c, code, message, cb)),
      ctx,
      (err) => {
        if (err) {
          this.wsError(ctx, err);
          return;
        }
        this.closeStillOpenLeg(ctx, code, message);
      },
    );
  }

  private wsError(ctx: WsContext, err: Error): void {
    for (const handler of this.onWebSocketErrorHandlers) handler(ctx, err);
    this.closeStillOpenLeg(ctx);
  }

  /**
   * Closes whichever leg (client/server) is still OPEN once the other has
   * already CLOSED — mirrors the pre-issue-#42 engine's own close/error
   * cross-signaling, so one side dropping (cleanly via `wsClose`, or via an
   * error through `wsError`) doesn't leave the other hanging open forever.
   * A no-op if either leg doesn't exist yet (e.g. an error before
   * `connectUpstreamWebSocket` ever created `serverWs` — see
   * `handleWebSocketConnection`'s own direct cleanup for that case) or both
   * are already in the same state.
   */
  private closeStillOpenLeg(ctx: WsContext, code?: number, message?: Buffer): void {
    const client = ctx.clientWs;
    const server = ctx.serverWs;
    if (!client || !server || client.readyState === server.readyState) return;
    let stillOpen: WebSocket | undefined;
    if (client.readyState === WebSocket.OPEN) stillOpen = client;
    else if (server.readyState === WebSocket.OPEN) stillOpen = server;
    if (!stillOpen) return;
    try {
      if (code === undefined || code === 1005) stillOpen.close();
      else stillOpen.close(code, message);
    } catch {
      // Best-effort — the connection is already in a broken state either way.
    }
  }
}

function listenAsync(server: net.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
