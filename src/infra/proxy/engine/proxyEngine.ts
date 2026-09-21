import crypto from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import WebSocket, { WebSocketServer } from 'ws';
import {
  PROXY_AUTHENTICATE_CHALLENGE,
  PROXY_AUTHORIZATION_HEADER,
  verifyProxyCredentials,
  type ProxyAuthCredentials,
} from '../../../domain/auth/proxyAuth';
import type { ExchangeTiming, UpstreamCertificate } from '../../../domain/exchange/types';
import { createUpstreamProxyAgents } from '../upstreamProxyAgent';
import type { UpstreamTlsOptions } from '../upstreamTlsOptions';
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
  ProxyToServerRequestOptions,
  UpstreamRequest,
  UpstreamResponse,
} from './types';
import { UPSTREAM_KEEP_ALIVE_TIMEOUT_MS } from './keepAliveTiming';
import { captureUpstreamCertificate } from './upstreamCertificate';
import {
  adaptHttp2Response,
  buildHttp2RequestHeaders,
  requestOverSecuredSocket,
  UpstreamHttp2Pool,
  type AcquiredConnection,
} from './upstreamHttp2';

export interface ProxyEngineOptions {
  port: number;
  host: string;
  sslCaDir: string;
  /** @default true */
  http2?: boolean;
  /**
   * Routes every proxy→upstream connection through this HTTP(S)/SOCKS proxy
   * instead of connecting to the real destination directly (issue #145) —
   * e.g. `http://user:pass@proxy.corp.example.com:8080` or
   * `socks5://127.0.0.1:1080`. Already validated by the caller (`cli.ts`'s
   * eager `validateUpstreamProxyUrl` — see its own doc comment for why).
   * Omit for direct connections (the default).
   */
  upstreamProxyUrl?: string;
  /**
   * Requires every client to present these credentials (as
   * `Proxy-Authorization: Basic …`) before the proxy will do anything for
   * it — issue #158's `--proxy-auth`. Omit (the default) to accept every
   * client, which is what Detour did before this existed.
   */
  proxyAuth?: ProxyAuthCredentials;
  /**
   * Upstream TLS verification/mTLS overrides (issue #160) — `--upstream-ca`/
   * `--insecure-upstream`/`--client-cert`+`--client-key`. Applied as
   * per-request options in `forwardRequest` (see that method's own doc
   * comment for why it can't be baked into `httpsAgent`'s constructor
   * instead), so this applies identically whether or not `upstreamProxyUrl`
   * is also given. Omit for Node's own default verification behavior
   * against its bundled root store, with no client certificate — what
   * Detour did before this existed.
   */
  upstreamTls?: UpstreamTlsOptions;
  /**
   * Whether the proxy→upstream leg attempts HTTP/2 at all (issue #166's
   * `--no-http2-upstream`) — separate from `http2` above, which only ever
   * governs the client-facing MITM'd side. `false` pins every upstream
   * request to HTTP/1.1, matching Detour's behavior before this existed.
   * Also implicitly `false` (regardless of this setting) once
   * `upstreamProxyUrl` is given — see `UpstreamHttp2Pool`'s own doc comment
   * for why the two don't compose yet.
   * @default true
   */
  http2Upstream?: boolean;
}

/**
 * `httpAgent`/`httpsAgent`'s shared keep-alive tuning (issue #162) — pulled
 * out to a constant so both agents' constructors, and `listen()`'s own
 * rebuild of them via `createUpstreamProxyAgents` when `--upstream-proxy`
 * is set, share identical values without duplicating (or accidentally
 * drifting from) them. Unrelated to issue #160's `upstreamTls`: those
 * options are threaded per-request rather than baked into either agent's
 * constructor — see `ProxyEngineOptions.upstreamTls`'s own doc comment for
 * why.
 */
const KEEP_ALIVE_AGENT_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: UPSTREAM_KEEP_ALIVE_TIMEOUT_MS,
} as const;

/** A request/response pair's actual mutable hook lists — `IContext`'s public surface plus the bookkeeping `ProxyEngine` needs internally, never exposed to consumers. */
interface Context extends IContext {
  onRequestDataHandlers: OnRequestDataParams[];
  onRequestEndHandlers: OnRequestParams[];
  onResponseDataHandlers: OnRequestDataParams[];
  onResponseEndHandlers: OnRequestParams[];
  /**
   * An h2 upstream response's trailing headers (issue #166) — e.g. gRPC's
   * `grpc-status`/`grpc-message`, sent as a second HEADERS frame after the
   * body rather than up front. Forwarded to the client only when it's also
   * h2 (`pumpResponseBody`'s `finish`) — purely internal bookkeeping, not
   * part of `IContext`'s public surface, since no pipeline handler needs to
   * read or set it itself.
   */
  upstreamTrailers?: IncomingHttpHeaders;
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

/**
 * Reads the client's `Proxy-Authorization` header (issue #158). Anything
 * other than a single string value — absent, or the array Node produces for
 * a header sent more than once — is treated as "no credentials": an
 * ambiguous pair of values is exactly the sort of request smuggling that
 * shouldn't get a second chance at guessing.
 */
function readProxyAuthorization(req: IncomingMessage): string | undefined {
  const value = req.headers[PROXY_AUTHORIZATION_HEADER];
  return typeof value === 'string' ? value : undefined;
}

/** The `407` sent down a raw CONNECT socket, which (unlike the request path) has no `ServerResponse` to write through — hand-built and closed immediately, so no tunnel is ever established. */
function rejectUnauthenticatedConnect(socket: Duplex): void {
  if (socket.destroyed) return;
  socket.end(
    'HTTP/1.1 407 Proxy Authentication Required\r\n' +
      `Proxy-Authenticate: ${PROXY_AUTHENTICATE_CHALLENGE}\r\n` +
      'Content-Length: 0\r\n' +
      'Connection: close\r\n' +
      '\r\n',
  );
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

  // Typed as plain `http.Agent` (not `https.Agent` for the second one) since
  // that's all `IContext.proxyToServerRequestOptions.agent` ever needs — see
  // `createUpstreamProxyAgents`'s doc comment for why that matters once
  // `--upstream-proxy` (issue #145) replaces these with a proxy-routing
  // agent that isn't literally an `https.Agent` instance.
  //
  // `keepAlive: true` (issue #162): every proxied request used to pay a
  // fresh TCP+TLS handshake to the upstream host, even the 2nd+ request to
  // the exact same one in the same session — 2 round trips of pure overhead
  // a real (non-proxied) client never pays past its first request. Bounded
  // rather than left at the default `Infinity`: an HTTP/2 client fanning
  // many concurrent streams out to the same upstream host (Detour always
  // downgrades to HTTP/1.1 on that leg) would otherwise open one socket per
  // stream with no ceiling, which is both a local fd-exhaustion risk and a
  // good way to trip an upstream server's own per-client connection limit.
  // Once `maxSockets` is reached, Node's own `Agent` queues further
  // requests to that host rather than rejecting them — the "queueing"
  // acceptance criterion falls out of the built-in behavior, not something
  // this needs to implement itself. `keepAliveMsecs`/`timeout` are the
  // values Node's own docs suggest as sane defaults for a keep-alive pool
  // this size; `maxFreeSockets` caps how many idle-but-reusable sockets
  // stick around per host once traffic quiets down.
  private httpAgent: http.Agent = new http.Agent(KEEP_ALIVE_AGENT_OPTIONS);
  private httpsAgent: http.Agent = new https.Agent(KEEP_ALIVE_AGENT_OPTIONS);

  private httpServer: http.Server | undefined;
  private tlsServer: https.Server | http2.Http2SecureServer | undefined;

  /** `ProxyEngineOptions.proxyAuth` (issue #158), captured on `listen` — `undefined` leaves the proxy open to every client, as it was before that flag existed. */
  private proxyAuth: ProxyAuthCredentials | undefined;

  /** `ProxyEngineOptions.upstreamTls` (issue #160), captured on `listen` — `undefined` leaves every HTTPS upstream request at Node's own default verification, no client certificate, as it was before this flag existed. */
  private upstreamTls: UpstreamTlsOptions | undefined;

  /**
   * Caches each fresh socket's real upstream TLS certificate (issue #160),
   * keyed by the socket itself — a `WeakMap` so an entry is reclaimed
   * automatically once its socket closes and is garbage-collected, with no
   * eviction logic to write or bound to pick. Populated once, in
   * `trackSocketTiming`'s fresh-connection branch (on `secureConnect`), and
   * read back in its reused-connection branch: a keep-alive socket
   * (`keepAlive: true`, issue #162) only ever re-handshakes on its first
   * use, so every later request riding the same socket needs this cache to
   * still report a certificate at all.
   */
  private certificatesBySocket = new WeakMap<net.Socket, UpstreamCertificate>();

  /** `ProxyEngineOptions.http2Upstream` (issue #166) folded together with `!upstreamProxyUrl` — see `UpstreamHttp2Pool`'s doc comment for why an upstream proxy disables this regardless of the flag. `false` skips `http2Pool.acquire` entirely and dispatches every HTTPS request as HTTP/1.1, exactly as `ProxyEngine` did before this existed. */
  private http2UpstreamEnabled = true;

  /** One h2 session (or "HTTP/1.1-only") per upstream host, for the proxy→upstream leg (issue #166) — see `UpstreamHttp2Pool`'s own doc comment. */
  private readonly http2Pool = new UpstreamHttp2Pool();

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
      this.proxyAuth = options.proxyAuth;
      this.upstreamTls = options.upstreamTls;
      // See `UpstreamHttp2Pool`'s doc comment for why an upstream proxy
      // disables this regardless of `http2Upstream` — ALPN-probing over a
      // CONNECT tunnel through it is out of scope for issue #166.
      this.http2UpstreamEnabled = (options.http2Upstream ?? true) && !options.upstreamProxyUrl;

      if (options.upstreamProxyUrl) {
        const agents = createUpstreamProxyAgents(options.upstreamProxyUrl);
        this.httpAgent = agents.httpAgent;
        this.httpsAgent = agents.httpsAgent;
      }

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
    this.http2Pool.closeAll();
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

  /**
   * Gates `req` on `--proxy-auth` (issue #158), calling `onAllowed` when the
   * client presented valid credentials (or when no credentials are
   * configured at all) and `onDenied` when it didn't.
   *
   * Called at the very top of every client-facing entry point *before* any
   * registered hook runs — which is what puts it ahead of Block Hosts,
   * Focus, and the rule engine as a whole (all of them live in
   * `proxyServer.ts`'s `onConnect`/`onRequest` handlers): an unauthenticated
   * client never reaches any of that, and never produces a captured
   * exchange, a dashboard broadcast or a dump file.
   *
   * A rejected verification promise denies rather than propagating: there's
   * no failure mode of the KDF that should be answered by letting the client
   * through, and an unhandled rejection here would take the process down.
   */
  private guardProxyAuth(req: IncomingMessage, onDenied: () => void, onAllowed: () => void): void {
    const credentials = this.proxyAuth;
    if (!credentials) {
      onAllowed();
      return;
    }
    verifyProxyCredentials(credentials, readProxyAuthorization(req)).then(
      (authenticated) => (authenticated ? onAllowed() : onDenied()),
      () => onDenied(),
    );
  }

  /** Authenticates the CONNECT itself (issue #158) before anything else sees it — a client that can't authenticate gets a `407` and no tunnel, so it never even reaches the `onConnect` handlers below. */
  private handleConnect(req: IncomingMessage, socket: Duplex, head: Buffer, internalPort: number): void {
    socket.on('error', (err) => this.onSocketError('CLIENT_TO_PROXY_SOCKET', err));
    this.guardProxyAuth(
      req,
      () => rejectUnauthenticatedConnect(socket),
      () => this.runConnectHandlers(req, socket, head, internalPort),
    );
  }

  /** Runs the registered `onConnect` handlers (Block Hosts / Focus / passthrough dispatch — see `proxyServer.ts`); if every one calls back without handling the tunnel itself, MITMs it by bridging the raw client socket into the internal TLS/HTTP2 server. */
  private runConnectHandlers(req: IncomingMessage, socket: Duplex, head: Buffer, internalPort: number): void {
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

  /**
   * Entry point for every request the client sends *to the proxy itself*
   * (`isSSL: false`) and for every request inside an already-established
   * MITM tunnel (`isSSL: true`).
   *
   * Only the former is gated on `--proxy-auth` (issue #158): a tunnelled
   * request arrives on a connection whose own CONNECT already authenticated
   * (`handleConnect`), and no client re-sends `Proxy-Authorization` inside
   * the tunnel — it's a hop-by-hop header addressed to the proxy, and the
   * proxy's hop ended at the CONNECT. Re-checking here would reject every
   * HTTPS request in existence.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse, isSSL: boolean): void {
    const ctx = this.buildContext(req, res, isSSL);
    req.on('error', (err) => this.emitError('CLIENT_TO_PROXY_REQUEST_ERROR', ctx, err));
    res.on('error', (err) => this.emitError('PROXY_TO_CLIENT_RESPONSE_ERROR', ctx, err));
    req.pause();

    if (isSSL) {
      this.forwardRequest(ctx);
      return;
    }
    this.guardProxyAuth(
      req,
      () => this.rejectUnauthenticatedRequest(ctx),
      () => this.forwardRequest(ctx),
    );
  }

  /** Answers a request that failed `--proxy-auth` (issue #158) with the `407` challenge, draining whatever body it carried first so the client reads the response instead of an abruptly-reset socket. Only ever reached on the plain HTTP/1.1 proxy port, so the HTTP/1-only `Connection` header is always legal here. */
  private rejectUnauthenticatedRequest(ctx: Context): void {
    ctx.clientToProxyRequest.resume();
    const res = ctx.proxyToClientResponse;
    res.writeHead(407, {
      'Proxy-Authenticate': PROXY_AUTHENTICATE_CHALLENGE,
      'Content-Type': 'text/plain; charset=utf-8',
      Connection: 'close',
    });
    res.end('Proxy authentication required', 'utf-8');
  }

  private forwardRequest(ctx: Context): void {
    const req = ctx.clientToProxyRequest;
    const res = ctx.proxyToClientResponse;
    const isSSL = ctx.isSSL;
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
      // Per-request, not baked into `httpsAgent` — see this field's own doc
      // comment in `engine/types.ts` for why (issue #160). Only meaningful
      // for `isSSL`; harmless (and ignored by `http.request`) otherwise.
      ...(isSSL ? this.upstreamTls : undefined),
    };

    runChain(this.onRequestHandlers, ctx, (err) => {
      if (err) {
        this.emitError('ON_REQUEST_ERROR', ctx, err);
        return;
      }
      this.makeProxyToServerRequest(ctx);
    });
  }

  /**
   * Entry point for dispatching the actual proxy→upstream request (issue
   * #166 branches this three ways): a plain HTTP request always goes out
   * as HTTP/1.1 (h2c is out of scope — see `UpstreamHttp2Pool`'s doc
   * comment), same for HTTPS once `http2UpstreamEnabled` is off; otherwise
   * `http2Pool.acquire` decides per-host whether this goes out over h2 or
   * falls back to h1, ALPN-probing on the host's first-ever request.
   */
  private makeProxyToServerRequest(ctx: Context): void {
    const opts = ctx.proxyToServerRequestOptions!;
    const timing: ExchangeTiming = {};
    ctx.timing = timing;

    if (!ctx.isSSL || !this.http2UpstreamEnabled) {
      this.dispatchHttp1Request(ctx, opts, timing, undefined);
      return;
    }

    const port = typeof opts.port === 'number' ? opts.port : Number(opts.port ?? 443);
    this.http2Pool.acquire(opts.host, port, this.upstreamTls).then(
      (acquired) => this.dispatchWithAcquiredConnection(ctx, opts, timing, acquired),
      (err) =>
        this.emitError('PROXY_TO_SERVER_REQUEST_ERROR', ctx, err instanceof Error ? err : new Error(String(err))),
    );
  }

  /** Routes an `UpstreamHttp2Pool.acquire` result (issue #166) to the h1 or h2 dispatch path, attaching whatever the pool already learned (certificate, connect timing/reuse) along the way. */
  private dispatchWithAcquiredConnection(
    ctx: Context,
    opts: ProxyToServerRequestOptions,
    timing: ExchangeTiming,
    acquired: AcquiredConnection,
  ): void {
    if (acquired.certificate) ctx.certificate = acquired.certificate;

    if (acquired.protocol === 'HTTP/2') {
      if (acquired.reused) timing.connectionReused = true;
      else Object.assign(timing, acquired.timing);
      this.dispatchHttp2Request(ctx, opts, timing, acquired.session);
      return;
    }

    if (acquired.socket) Object.assign(timing, acquired.timing);
    this.dispatchHttp1Request(ctx, opts, timing, acquired.socket);
  }

  /**
   * The HTTP/1.1 upstream path — unchanged from before issue #166 except
   * for `presetSocket`: when `UpstreamHttp2Pool.acquire` already probed
   * this host and found it HTTP/1.1-only, the exact socket that probe
   * secured is handed straight to `requestOverSecuredSocket` instead of
   * going through `this.httpsAgent` (which would otherwise open a second,
   * entirely redundant connection for this one request) — see that
   * function's own doc comment for why a plain `http.Agent`, not
   * `https.request`, is what makes reusing an already-secured socket work.
   * Every request after this one goes through the ordinary agent exactly
   * as before, once the host is cached as HTTP/1.1-only.
   */
  private dispatchHttp1Request(
    ctx: Context,
    opts: ProxyToServerRequestOptions,
    timing: ExchangeTiming,
    presetSocket: TLSSocket | undefined,
  ): void {
    ctx.upstreamProtocol = 'HTTP/1.1';
    let connectionReadyAt = Date.now();
    const onResponse = (upstreamRes: IncomingMessage): void => {
      const headersAt = Date.now();
      timing.ttfbMs = headersAt - connectionReadyAt;
      ctx.responseHeadersAt = headersAt;
      this.onUpstreamResponse(ctx, upstreamRes);
    };

    let upstreamReq: UpstreamRequest;
    if (presetSocket) {
      upstreamReq = requestOverSecuredSocket(opts, presetSocket, onResponse);
    } else {
      const transport = ctx.isSSL ? https : http;
      upstreamReq = transport.request(opts, onResponse);
    }
    ctx.proxyToServerRequest = upstreamReq;

    if (!presetSocket) {
      upstreamReq.on('socket', (socket) =>
        this.trackSocketTiming(socket, ctx.isSSL, timing, {
          onReady: (readyAt) => {
            connectionReadyAt = readyAt;
          },
          onCertificate: (cert) => {
            ctx.certificate = cert;
          },
        }),
      );
    }
    // `presetSocket` is already past `secureConnect` by the time this ever
    // runs (issue #166's ALPN probe already measured its dns/tcp/tls
    // phases — see `dispatchWithAcquiredConnection`) — `connectionReadyAt`
    // is just "now", with nothing left for `trackSocketTiming` to do.
    upstreamReq.on('error', (err) => this.emitError('PROXY_TO_SERVER_REQUEST_ERROR', ctx, err));
    this.pumpRequestBody(ctx);
  }

  /**
   * The HTTP/2 upstream path (issue #166): builds pseudo-headers via
   * `buildHttp2RequestHeaders` and opens a new multiplexed stream on the
   * shared session `UpstreamHttp2Pool` already established for this host.
   * `endStream: false` because the request body (if any) is still to come,
   * streamed by `pumpRequestBody` exactly like the h1 path.
   */
  private dispatchHttp2Request(
    ctx: Context,
    opts: ProxyToServerRequestOptions,
    timing: ExchangeTiming,
    session: http2.ClientHttp2Session,
  ): void {
    const headers = buildHttp2RequestHeaders(opts, ctx.isSSL);
    const connectionReadyAt = Date.now();
    let stream: http2.ClientHttp2Stream;
    try {
      stream = session.request(headers, { endStream: false });
    } catch (err) {
      this.emitError('PROXY_TO_SERVER_REQUEST_ERROR', ctx, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // Only after `session.request()` actually succeeds — tagging the
    // exchange `'HTTP/2'` before that point would mislabel a request that
    // never went out over HTTP/2 at all (e.g. a session destroyed/GOAWAY'd
    // in the brief window between `acquire()` resolving and this call).
    ctx.upstreamProtocol = 'HTTP/2';
    ctx.proxyToServerRequest = stream;

    // Only for a failure *before* the response arrives (send failure,
    // connection reset pre-headers) — removed the instant `onUpstreamResponse`
    // takes over below. `adaptHttp2Response` mutates and returns this exact
    // same `stream` object (unlike the h1 path, where the request and
    // response are two separate objects), so `onUpstreamResponse`'s own
    // `.on('error', ...)` would otherwise stack a second, permanent listener
    // on it: a post-headers failure would then fire both, double-reporting
    // one failure as two different (and conflicting) error kinds.
    const onPreResponseError = (err: Error): void => this.emitError('PROXY_TO_SERVER_REQUEST_ERROR', ctx, err);
    stream.on('error', onPreResponseError);

    stream.on('response', (responseHeaders) => {
      stream.off('error', onPreResponseError);
      const headersAt = Date.now();
      timing.ttfbMs = headersAt - connectionReadyAt;
      ctx.responseHeadersAt = headersAt;
      this.onUpstreamResponse(ctx, adaptHttp2Response(stream, responseHeaders));
    });
    // gRPC's trailing `grpc-status`/`grpc-message` (and any other h2
    // trailers) arrive as a second HEADERS frame after the body — captured
    // here so `pumpResponseBody`'s `finish` can forward them on to an h2
    // client (see that method's own doc comment; deliberately scoped to
    // h2-client-to-h2-upstream, matching gRPC's own requirement that both
    // legs speak h2).
    stream.on('trailers', (trailers) => {
      ctx.upstreamTrailers = trailers;
    });
    this.pumpRequestBody(ctx);
  }

  /**
   * Measures the DNS/TCP/TLS phases of the upstream socket
   * `makeProxyToServerRequest` just opened (issue #140), filling them into
   * `timing` as each stage completes and reporting via `onReady` once the
   * connection is actually usable — the point `ttfbMs` is measured from. A
   * reused keep-alive socket (`!socket.connecting`) skips straight to
   * `onReady` with no phases measured, flagging `timing.connectionReused`
   * (issue #162) so the dashboard's Waterfall can tell "genuinely nothing to
   * measure" apart from "this exchange rode an existing connection" — a
   * socket can only be trusted to still be connecting via this flag, not
   * assumed, which is exactly what makes this branch reachable at all now
   * that `httpAgent`/`httpsAgent` are `keepAlive: true`.
   *
   * The DNS/TCP baseline is `Date.now()` taken right here, at the moment
   * this actually runs (the request's `'socket'` event) — not the caller's
   * pre-dispatch timestamp. Those used to be indistinguishable: `keepAlive:
   * false` paired with an unbounded default `maxSockets` meant the Agent
   * always created (or, now, reused) a socket and fired `'socket'`
   * essentially synchronously with `transport.request()`. Now that
   * `httpAgent`/`httpsAgent` cap `maxSockets` (issue #162), a request past
   * that cap sits in the Agent's own internal queue until a socket frees up
   * — an unbounded wait that has nothing to do with DNS or TCP. Measuring
   * from the caller's timestamp would silently fold that queue wait into
   * `dnsMs`/`tcpMs`, inflating them for a reason that has nothing to do
   * with the network; measuring from here instead means those phases only
   * ever cover what actually happens once a socket exists.
   *
   * `onCertificate` (issue #160) reports the upstream's real TLS
   * certificate once known: for a fresh HTTPS socket, captured off
   * `secureConnect` and cached in `certificatesBySocket` (keyed by the
   * socket itself) for any later request that reuses it; for a reused one,
   * read straight back out of that cache — a keep-alive socket only ever
   * re-handshakes on its first use, so this is the only way a 2nd+ request
   * on it still gets a certificate at all. Grouped with `onReady` into one
   * options object (rather than a 5th positional parameter) to keep this
   * method's own parameter count from creeping back up.
   */
  private trackSocketTiming(
    socket: net.Socket,
    isSSL: boolean,
    timing: ExchangeTiming,
    callbacks: { onReady: (readyAt: number) => void; onCertificate: (cert: UpstreamCertificate) => void },
  ): void {
    const { onReady, onCertificate } = callbacks;
    const socketAssignedAt = Date.now();
    if (!socket.connecting) {
      timing.connectionReused = true;
      onReady(socketAssignedAt);
      if (isSSL) {
        const cached = this.certificatesBySocket.get(socket);
        if (cached) onCertificate({ ...cached, fromReusedConnection: true });
      }
      return;
    }
    let lookupDoneAt: number | undefined;
    let connectedAt: number | undefined;
    socket.once('lookup', () => {
      lookupDoneAt = Date.now();
      timing.dnsMs = lookupDoneAt - socketAssignedAt;
    });
    socket.once('connect', () => {
      connectedAt = Date.now();
      timing.tcpMs = connectedAt - (lookupDoneAt ?? socketAssignedAt);
      if (!isSSL) onReady(connectedAt);
    });
    if (isSSL) {
      socket.once('secureConnect', () => {
        const securedAt = Date.now();
        timing.tlsMs = securedAt - (connectedAt ?? socketAssignedAt);
        const cert = captureUpstreamCertificate(socket as TLSSocket);
        if (cert) {
          this.certificatesBySocket.set(socket, cert);
          onCertificate(cert);
        }
        onReady(securedAt);
      });
    }
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
    source: IncomingMessage | UpstreamResponse;
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

  private onUpstreamResponse(ctx: Context, upstreamRes: UpstreamResponse): void {
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
      // The client→proxy leg is still always closed after one response,
      // regardless of whether the proxy→upstream leg above just reused a
      // keep-alive socket (issue #162) — reusing the *downstream* connection
      // too needs its own careful pass (response-framing correctness under
      // a `rewrite`/`script`/gzip'd body first — see issue #162's own
      // writeup) and is deliberately out of scope here. Telling an HTTP/1.1
      // client to close still matches what actually happens on this leg.
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
          // Forwards an h2 upstream's trailing headers (issue #166) — e.g.
          // gRPC's `grpc-status`/`grpc-message` — on to the client, but
          // only when it's also h2: gRPC itself requires h2 on both legs,
          // and HTTP/1.1 trailers need a `Trailer` header declared ahead of
          // the body (before any of it is known to exist here), which is a
          // separate, currently out-of-scope problem this doesn't attempt.
          if (ctx.upstreamTrailers && isHttp2(ctx.clientToProxyRequest) && !client.writableEnded) {
            try {
              client.addTrailers(ctx.upstreamTrailers);
            } catch (trailerErr) {
              // Best-effort — a client that already went away shouldn't
              // stop the response from ending; see emitError's own
              // similar reasoning for a write against a dead h2 stream.
              this.emitError(
                'RESPONSE_TRAILERS_WRITE_FAILED',
                null,
                trailerErr instanceof Error ? trailerErr : new Error(String(trailerErr)),
              );
            }
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

  /**
   * `--proxy-auth` (issue #158) has to be enforced here too, not just in
   * `handleConnect`/`handleRequest`: a `ws://` upgrade sent to the proxy
   * port is consumed by this `WebSocketServer`'s own `'upgrade'` listener
   * and never reaches `handleRequest` at all, so without this gate an
   * unauthenticated client could still relay arbitrary traffic through
   * Detour over a WebSocket. `verifyClient`'s callback form runs *before*
   * the handshake completes, so a denial is a plain `407` with the same
   * challenge every other rejection carries — not a socket that opens and
   * then closes.
   *
   * Only for the plain proxy port (`isSSL: false`) — a `wss://` upgrade
   * inside a MITM tunnel was already authenticated by its CONNECT, same
   * reasoning as `handleRequest`'s.
   */
  private attachWebSocketServer(server: http.Server | https.Server | http2.Http2SecureServer, isSSL: boolean): void {
    const wss = new WebSocketServer({
      server: server as http.Server,
      verifyClient: isSSL
        ? undefined
        : (info, callback) =>
            this.guardProxyAuth(
              info.req,
              () =>
                callback(false, 407, 'Proxy Authentication Required', {
                  'Proxy-Authenticate': PROXY_AUTHENTICATE_CHALLENGE,
                }),
              () => callback(true),
            ),
    });
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
      const lower = key.toLowerCase();
      // `sec-websocket-*` belongs to this hop's handshake (`ws` mints its
      // own for the upstream leg), and `proxy-*` is addressed to the proxy
      // rather than the origin — `Proxy-Authorization` above all, which
      // carries Detour's own credentials (issue #158) and must never be
      // relayed onward or land in this connection's captured
      // `requestHeaders` (see `proxyServer.ts`'s `onWebSocketConnection`,
      // which copies this object verbatim). Mirrors the identical
      // `/^proxy-/i` filter on the plain-request path in `forwardRequest`.
      if (lower.startsWith('sec-websocket') || lower.startsWith('proxy-')) continue;
      headers[key] = flattenHeaderValue(upgradeReq.headers[key]);
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
