import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { isHostBlocked, normalizeBlockHosts } from '../../domain/blockHosts/blockHostsPolicy';
import { BodyCapture } from '../../domain/exchange/bodyCapture';
import { compactHeaders, deleteHeader, flattenHeaders } from '../../domain/exchange/headers';
import type {
  BlockHostsState,
  BreakpointRequestPayload,
  BreakpointResponsePayload,
  BreakpointResumeCommand,
  CapturedExchange,
  CapturedWebSocketConnection,
  ThrottleState,
  WebSocketFrameRecord,
} from '../../domain/exchange/types';
import { recordWebSocketFrame } from '../../domain/exchange/webSocketCapture';
import { connectMatchUrl, formatHostPort, isHostFocused, normalizeFocusHosts } from '../../domain/focus/focusPolicy';
import type { ScriptModule, ScriptRequestInfo, ScriptResponseInfo } from '../../domain/rules/scriptAction';
import type { Rule } from '../../domain/rules/types';
import { BandwidthState, transferDelayMs } from '../../domain/throttle/bandwidth';
import { DEFAULT_THROTTLE_STATE, normalizeThrottleState } from '../../domain/throttle/throttlePolicy';
import { BreakpointCoordinator } from '../../usecase/breakpointCoordinator';
import { resolveConnectRoute } from '../../usecase/resolveConnectRoute';
import { resolveExchangeAction } from '../../usecase/resolveExchangeAction';
import type { RuleEngine } from '../../usecase/ruleEngine';
import { runBeforeRequest, runBeforeResponse } from '../../usecase/runScriptHooks';
import { resolveCertDir } from '../certStore';
import type { DetourEventBus } from '../eventBus';
import { assertPortAvailable } from '../portCheck';
import {
  applyRequestRewrite,
  applyResponseHeaderRewrite,
  applyRouteAction,
  installResponseBodyRewrite,
  loadScriptModule,
  resolveMockResponse,
  sendMockResponse,
  sendMockSimulate,
  type MockResponse,
} from './actionsRuntime';
import { ProxyEngine } from './engine/proxyEngine';
import type { ErrorCallback, IContext, IWebSocketContext } from './engine/types';
import { createThrottleTransform } from './throttleTransform';

/**
 * Captures the client's raw request body directly off `clientToProxyRequest`
 * into a fresh `BodyCapture`, resuming the stream so `data`/`end` actually
 * fire. Shared by the `mock` and `breakpoint` (request-phase) branches
 * below, neither of which forwards via the normal onRequestData/onRequestEnd
 * pipeline — that pipeline only starts flowing once `callback()` is called,
 * which neither branch does (a mock never reaches upstream; a breakpoint
 * needs the full body available for the dashboard to inspect/edit first).
 */
function captureClientRequestBody(ctx: IContext, exchange: CapturedExchange): BodyCapture {
  const requestCapture = new BodyCapture();
  ctx.clientToProxyRequest.on('data', (chunk: Buffer) => {
    exchange.requestBodySize += chunk.length;
    requestCapture.add(chunk);
  });
  // ProxyEngine pauses ctx.clientToProxyRequest before onRequest runs; adding
  // a 'data' listener alone does NOT auto-resume a stream that was
  // explicitly paused (see Readable.prototype.on in Node's stream
  // internals), so without this, the request stream never emits 'data'/'end'
  // and a caller waiting on it would deadlock forever.
  ctx.clientToProxyRequest.resume();
  return requestCapture;
}

export interface ProxyServerOptions {
  port: number;
  host?: string;
  /** When set, requests are matched against rules.json (mock/route/rewrite/script) before/while proxying. */
  ruleEngine?: RuleEngine;
  /**
   * Whether the internal MITM'd TLS server negotiates HTTP/2 via ALPN
   * (falling back to HTTP/1.1 for clients that don't offer it) — issue #16's
   * `ProxyEngine.listen`'s `http2` option. Plain (non-CONNECT) `http://`
   * traffic and the proxy→upstream leg are unaffected either way — only the
   * client-facing HTTPS side can negotiate HTTP/2.
   * @default true
   */
  http2Enabled?: boolean;
}

export interface ProxyServerHandle {
  /** Port the proxy actually bound to (relevant when options.port is 0). */
  port: number;
  /** Path to the auto-generated root CA, for the user to install/trust. */
  caCertPath: string;
  stop(): Promise<void>;
}

/**
 * Builds a fully-qualified URL for the captured exchange.
 *
 * By the time our onRequest handler runs, ProxyEngine has already
 * parsed the target host/port into `proxyToServerRequestOptions` and
 * rewritten `clientToProxyRequest.url` down to a bare path (it strips
 * the `http://host` prefix for plain forward-proxy requests, and
 * CONNECT-tunneled HTTPS requests never had it to begin with). So
 * `proxyToServerRequestOptions` — not the Host header, which a client
 * could in principle omit or misreport — is the authoritative source
 * for where this request is actually headed.
 */
function resolveUrl(ctx: IContext): { url: string; host: string } {
  const scheme = ctx.isSSL ? 'https' : 'http';
  const opts = ctx.proxyToServerRequestOptions;
  const host = opts?.host ?? ctx.clientToProxyRequest.headers.host ?? 'unknown-host';
  const defaultPort = ctx.isSSL ? 443 : 80;
  const port = opts?.port;
  const hostname = port && Number(port) !== defaultPort ? `${host}:${port}` : String(host);
  const path = opts?.path ?? ctx.clientToProxyRequest.url ?? '/';
  return { url: `${scheme}://${hostname}${path}`, host: hostname };
}

/**
 * Extracts the target `ws://`/`wss://` URL and bare host from a WebSocket
 * context. `ctx.proxyToServerWebSocketOptions.url` is already fully
 * resolved by ProxyEngine by the time `onWebSocketConnection` fires (from
 * either the upgrade request's absolute URL, or its `Host` header — see
 * `handleWebSocketConnection` in engine/proxyEngine.ts), so unlike
 * `resolveUrl` above there's no host/port reassembly to do here.
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

/** Builds the initial `CapturedExchange` for a request just as it starts, before its outcome (blocked/mock/route/rewrite/forwarded) is known. Shared by the Block Hosts branch and the normal rule-resolution path in `proxy.onRequest` below. */
function buildBaseExchange(
  ctx: IContext,
  info: { url: string; method: string; host: string; ruleName: string | undefined },
): CapturedExchange {
  return {
    id: ctx.uuid,
    method: info.method,
    url: info.url,
    host: info.host,
    isSSL: ctx.isSSL,
    // Set by Node itself on the client-facing request: `2` when the client
    // ALPN-negotiated HTTP/2 against ProxyEngine's internal MITM'd TLS
    // server, `1` otherwise. The proxy→upstream leg is unaffected either
    // way — ProxyEngine always forwards as plain HTTP/1.1.
    protocol: ctx.clientToProxyRequest.httpVersionMajor === 2 ? 'HTTP/2' : 'HTTP/1.1',
    requestHeaders: { ...ctx.clientToProxyRequest.headers },
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: Date.now(),
    ruleName: info.ruleName,
  };
}

/**
 * Resolves a `mock` rule's response, falling back to a 500 describing the
 * failure (e.g. an unreadable `bodyFile`) rather than crashing the proxy
 * or silently passing the request through.
 */
function tryResolveMock(
  rule: Rule,
  basePath: string,
  allowExternalPaths: boolean,
  onError: (message: string) => void,
): MockResponse {
  try {
    return resolveMockResponse(rule.action as Extract<Rule['action'], { type: 'mock' }>, basePath, allowExternalPaths);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onError(message);
    return {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: Buffer.from(`detour: mock rule "${rule.name}" failed to build its response: ${message}`, 'utf8'),
    };
  }
}

/**
 * Loads a `script` rule's module, reporting (via `onError`) rather than
 * throwing if the file is missing/unreadable/malformed — a broken script
 * shouldn't take down the proxy, just fall back to forwarding the exchange
 * untouched (same philosophy as `tryResolveMock`'s 500 fallback, minus the
 * mock response since a script rule has no response of its own to fall
 * back to).
 */
function tryLoadScriptModule(
  rule: Rule,
  basePath: string,
  allowExternalPaths: boolean,
  onError: (message: string) => void,
): ScriptModule | undefined {
  try {
    return loadScriptModule(rule.action as Extract<Rule['action'], { type: 'script' }>, basePath, allowExternalPaths);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onError(`rule "${rule.name}": failed to load script "${(rule.action as { path: string }).path}": ${message}`);
    return undefined;
  }
}

/**
 * Starts the MITM proxy: intercepts HTTP and HTTPS (via on-the-fly
 * per-host leaf certs signed by our local CA) traffic and publishes a
 * `request`/`response` event for every exchange on the given event bus.
 */
export async function startProxyServer(
  options: ProxyServerOptions,
  eventBus: DetourEventBus,
): Promise<ProxyServerHandle> {
  const host = options.host ?? 'localhost';
  await assertPortAvailable(options.port, host);

  const proxy = new ProxyEngine();
  const sslCaDir = resolveCertDir();
  const ruleEngine = options.ruleEngine;
  // Keyed by ctx.uuid so the request-phase and response-phase handlers
  // (which fire as separate callbacks) can agree on the same exchange.
  const inFlight = new Map<string, CapturedExchange>();
  // Keyed by ctx.uuid so the response-phase handlers know which rule (if
  // any) matched this request — matching itself only happens once, in
  // onRequest, since it's the same for both.
  const ruleContexts = new Map<string, Rule>();
  // Keyed by ctx.uuid: a `script` rule's module, loaded once from `onResponse`
  // (issue #9) so `onResponseHeaders`'s `handleScriptResponseHook` reuses the
  // exact instance that decided whether `beforeResponse` even exists, rather
  // than loading (and re-checking mtime) a second time.
  const scriptModules = new Map<string, ScriptModule>();
  // Keyed by ctx.uuid: the full (uncapped) request body actually forwarded
  // upstream for a `script` rule, set by `handleScriptRequestHook` and read
  // back by `handleScriptResponseHook` so a `beforeResponse` hook's `req`
  // argument is never the dashboard's capped display copy — see
  // `ScriptRequestInfo.body`'s doc comment ("always the full body"). Cleared
  // once the response phase either consumes or determines it doesn't need it
  // (see the `onResponse` handler below), or on a proxy-level error.
  const scriptRequestBodies = new Map<string, Buffer>();
  // Keyed by ctx.uuid (a WebSocket context's own, stable for its whole
  // lifecycle — see `handleWebSocketConnection` in engine/proxyEngine.ts),
  // so the frame/close/error hooks below (which fire as separate callbacks
  // over the life of one connection) can keep accumulating into the same
  // record (issue #17).
  const wsConnections = new Map<string, CapturedWebSocketConnection>();

  // Master on/off switch, toggled at runtime from the dashboard (see
  // `setIntercept`/`interceptChanged` in eventBus.ts). While disabled: HTTPS
  // is a raw TLS passthrough (handled entirely by the `proxy.onConnect` hook
  // below, which bypasses MITM decryption altogether) and mock/rewrite/
  // breakpoint rules are skipped for plain HTTP — a `route` rule keeps
  // applying either way.
  let interceptEnabled = true;
  const handleSetIntercept = (enabled: boolean): void => {
    interceptEnabled = enabled;
    eventBus.emit('interceptChanged', { enabled });
  };
  eventBus.on('setIntercept', handleSetIntercept);

  // "Focus" narrows interception down to a host allowlist, toggled at
  // runtime from the dashboard (see `setFocus`/`focusChanged` in
  // eventBus.ts). Empty (the default) means unrestricted — identical to
  // this feature not existing. Applied as an extra `&& isHostFocused(...)`
  // alongside `interceptEnabled` everywhere below, so a host outside the
  // list gets exactly the "intercept off" treatment (see `interceptEnabled`'s
  // doc comment) while every other host is unaffected.
  let focusHosts: string[] = [];
  const handleSetFocus = (hosts: string[]): void => {
    focusHosts = normalizeFocusHosts(hosts);
    eventBus.emit('focusChanged', { hosts: focusHosts });
  };
  eventBus.on('setFocus', handleSetFocus);

  // Simulated network conditions (bandwidth/latency/packet loss), toggled at
  // runtime from the dashboard (see `setThrottle`/`throttleChanged` in
  // eventBus.ts and `ThrottleState`'s doc comment). Disabled (the default)
  // is a true no-op — every read of `throttleState` below is guarded on
  // `.enabled`.
  let throttleState: ThrottleState = DEFAULT_THROTTLE_STATE;
  const handleSetThrottle = (state: ThrottleState): void => {
    throttleState = normalizeThrottleState(state);
    eventBus.emit('throttleChanged', throttleState);
  };
  eventBus.on('setThrottle', handleSetThrottle);

  // "Block Hosts" outright denies requests to matching hosts, toggled at
  // runtime from the dashboard (see `setBlockHosts`/`blockHostsChanged` in
  // eventBus.ts and `BlockHostsState`'s doc comment). Empty (the default) is
  // a true no-op. Checked before Focus/Intercept and the rule engine
  // everywhere below (both the CONNECT tunnel and the MITM'd onRequest
  // path), so a blocked host is denied unconditionally.
  let blockHostsState: BlockHostsState = { hosts: [], mode: 'forbidden' };
  const handleSetBlockHosts = (state: BlockHostsState): void => {
    blockHostsState = { hosts: normalizeBlockHosts(state.hosts), mode: state.mode };
    eventBus.emit('blockHostsChanged', blockHostsState);
  };
  eventBus.on('setBlockHosts', handleSetBlockHosts);

  // A `breakpoint` rule pauses an exchange by awaiting a promise resolved
  // from here, keyed by `${ctx.uuid}:${phase}`. Resolved either by a
  // matching `breakpointResume` from the dashboard, or synthetically (as an
  // abort) on a proxy-level error, so a dropped connection never leaves a
  // pause hanging forever.
  const breakpoints = new BreakpointCoordinator();
  const handleBreakpointResume = (command: BreakpointResumeCommand): void => breakpoints.resolve(command);
  eventBus.on('breakpointResume', handleBreakpointResume);

  /**
   * While intercept is off (globally, or for this one host via Focus), a
   * CONNECT tunnel is relayed byte-for-byte between the client and the real
   * upstream server instead of being terminated by our local per-host cert —
   * true TLS passthrough, since we never touch (or can see) the encrypted
   * bytes flowing through. A `route` rule still redirects the tunnel's
   * destination (matched on host/port only — there's no path/method to go on
   * without decrypting), and nothing about its contents is ever observable
   * or editable — but *where* it went and for how long is (see
   * `tunnelExchange` below), so a passthrough connection still shows up in
   * the log table instead of vanishing without a trace the moment Intercept
   * is off.
   */
  function handleInterceptOffConnect(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = ProxyEngine.parseHostAndPort(req, 443);
    if (!target?.host) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const originalPort = target.port ?? 443;
    const route = resolveConnectRoute(ruleEngine, target.host, originalPort);
    const destHost = route?.host ?? target.host;
    const destPort = route?.port ?? originalPort;

    // Recorded as a `CapturedExchange` the moment the tunnel is actually
    // established (in `finishConnect` below) — the tunnel's bytes are never
    // decrypted, so this is the one thing about it that's ever observable:
    // *where* it went and for how long, not what was said. `passthrough:
    // true` flags every other field (headers, body, status) as the
    // meaningless placeholder it is rather than real captured data — see
    // that field's own doc comment. Published through the same `request`/
    // `response` events (and so the same backlog/broadcast path) as a
    // decrypted exchange rather than a new event type, precisely so it
    // shows up in the existing log table/Group by host with no separate
    // plumbing.
    let tunnelExchange: CapturedExchange | undefined;
    let tunnelClosed = false;
    const closeTunnelExchange = (error?: string) => {
      if (!tunnelExchange || tunnelClosed) return;
      tunnelClosed = true;
      const finishedAt = Date.now();
      eventBus.emit('response', {
        ...tunnelExchange,
        finishedAt,
        durationMs: finishedAt - tunnelExchange.startedAt,
        error,
      });
    };

    // Once the tunnel is established, `socket` carries raw (opaque, possibly
    // mid-TLS-handshake) bytes end-to-end — an error past that point must
    // just tear the connection down, never write an HTTP status line into
    // what the client now treats as a byte stream.
    let established = false;
    const upstream = net.connect({ host: destHost, port: destPort }, () => {
      // Establishing (and throttling) the tunnel happens behind Throttle's
      // latency delay, same as the MITM path's onRequest below — but a
      // teardown (client/upstream error or close) can land during that
      // delay, so re-check both ends are still alive before touching them.
      const finishConnect = () => {
        if (socket.destroyed || upstream.destroyed) return;
        established = true;
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        tunnelExchange = {
          id: crypto.randomUUID(),
          method: 'CONNECT',
          url: connectMatchUrl(destHost, destPort),
          host: formatHostPort(destHost, destPort, 443),
          isSSL: true,
          protocol: 'HTTP/1.1',
          requestHeaders: {},
          requestBodySize: 0,
          responseBodySize: 0,
          startedAt: Date.now(),
          passthrough: true,
        };
        eventBus.emit('request', tunnelExchange);
        if (head.length > 0) upstream.write(head);
        if (throttleState.enabled && (throttleState.upKbps > 0 || throttleState.packetLossPct > 0)) {
          socket.pipe(createThrottleTransform(throttleState.upKbps, throttleState.packetLossPct)).pipe(upstream);
        } else {
          socket.pipe(upstream);
        }
        if (throttleState.enabled && (throttleState.downKbps > 0 || throttleState.packetLossPct > 0)) {
          upstream.pipe(createThrottleTransform(throttleState.downKbps, throttleState.packetLossPct)).pipe(socket);
        } else {
          upstream.pipe(socket);
        }
      };
      const latency = throttleState.enabled ? throttleState.latencyMs : 0;
      if (latency > 0) setTimeout(finishConnect, latency);
      else finishConnect();
    });
    const teardown = () => {
      closeTunnelExchange();
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', (err) => {
      eventBus.emit('error', {
        errorKind: 'INTERCEPT_OFF_TUNNEL_ERROR',
        message: `passthrough tunnel to ${destHost}:${destPort} failed: ${err.message}`,
      });
      if (!established && !socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      // Node emits 'error' before 'close' on a net.Socket, so this always
      // lands before `teardown`'s own (then no-op, thanks to `tunnelClosed`)
      // call below — the only reason the exchange's `error` field is ever
      // actually populated instead of a plain clean close.
      closeTunnelExchange(err.message);
    });
    socket.on('error', teardown);
    socket.once('close', teardown);
    upstream.once('close', teardown);
  }

  proxy.onConnect((req, socket, head, callback) => {
    // An unparseable target can't be checked against Block Hosts/Focus —
    // fall through to the normal intercept-enabled path (same as before
    // this feature), rather than treating "can't tell" as blocked/unfocused.
    const target = ProxyEngine.parseHostAndPort(req, 443);
    const formatted = target?.host ? formatHostPort(target.host, target.port ?? 443, 443) : undefined;
    if (formatted && isHostBlocked(blockHostsState.hosts, formatted)) {
      eventBus.emit('error', {
        errorKind: 'BLOCKED_HOST',
        message: `blocked CONNECT to ${formatted} (${blockHostsState.mode})`,
      });
      if (blockHostsState.mode === 'reset') {
        socket.destroy();
      } else {
        socket.end(
          `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\ndetour: CONNECT to "${formatted}" blocked by Block Hosts\n`,
        );
      }
      return;
    }
    const focused = !formatted || isHostFocused(focusHosts, formatted);
    if (interceptEnabled && focused) {
      callback();
      return;
    }
    handleInterceptOffConnect(req, socket, head as Buffer);
  });

  /**
   * WebSocket support (issue #17): ProxyEngine relays `ws://`/`wss://`
   * traffic transparently on its own (a `wss://` tunnel only ever reaches
   * these hooks once intercept has already MITM-decrypted it — see
   * `handleInterceptOffConnect` above; a passthrough tunnel's WS frames are
   * just opaque encrypted bytes to us like the rest of its traffic), so
   * these four hooks are purely observational: they build up a
   * `CapturedWebSocketConnection` per connection and publish it on the
   * event bus, mirroring `request`/`response` for HTTP exchanges. None of
   * them touch `data`/`flags` before calling back, so the actual proxied
   * traffic is never altered by recording it.
   */
  proxy.onWebSocketConnection((ctx, callback) => {
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
  });

  proxy.onWebSocketFrame((ctx, type, fromServer, data, flags, callback) => {
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
  });

  proxy.onWebSocketClose((ctx, code, message, callback) => {
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
    // Unlike `ErrorCallback` elsewhere in this file, `onWebSocketClose`'s
    // callback type doesn't mark its `err` parameter optional — pass `null`
    // explicitly to satisfy it (equivalent to "no error" here either way).
    callback(null);
  });

  proxy.onWebSocketError((ctx, err) => {
    // A connection already closed (and thus already reported via
    // `wsClose` above) is removed from `wsConnections`, so a follow-up
    // error on its other leg — see ProxyEngine's own close/error
    // cross-signaling in `wsClose`/`wsError` (engine/proxyEngine.ts) — is a
    // harmless no-op here rather than a second `wsClose` for the same
    // connection.
    const connection = wsConnections.get(ctx.uuid);
    if (connection) {
      connection.error = err?.message ?? 'unknown websocket error';
      connection.closedAt = Date.now();
      connection.durationMs = connection.closedAt - connection.openedAt;
      wsConnections.delete(ctx.uuid);
      eventBus.emit('wsClose', connection);
    }
    eventBus.emit('error', {
      id: ctx.uuid,
      errorKind: 'WEBSOCKET_ERROR',
      message: err?.message ?? 'unknown websocket error',
    });
  });

  proxy.onError((ctx, err, errorKind) => {
    if (ctx) {
      inFlight.delete(ctx.uuid);
      ruleContexts.delete(ctx.uuid);
      scriptModules.delete(ctx.uuid);
      scriptRequestBodies.delete(ctx.uuid);
      breakpoints.resolve({ id: ctx.uuid, phase: 'request', action: 'abort' });
      breakpoints.resolve({ id: ctx.uuid, phase: 'response', action: 'abort' });
    }
    eventBus.emit('error', {
      id: ctx?.uuid,
      errorKind: errorKind ?? 'UNKNOWN',
      message: err?.message ?? 'unknown proxy error',
    });
  });

  /**
   * Pauses a request matched by a `breakpoint` rule (request phase) before
   * it's forwarded upstream, and resumes/aborts it once the dashboard
   * responds.
   *
   * Mirrors the `mock` branch below: reads the client's request body
   * directly off `clientToProxyRequest` (rather than via
   * `onRequestData`/`onRequestEnd`, which only start flowing once `callback`
   * is called) so the full body is available for the dashboard to show and
   * edit before deciding whether/how to forward it. Once resumed, the
   * (possibly edited) body is written directly to `proxyToServerRequest`
   * from `onRequestEnd` — mirroring `installRequestBodyRewrite` — since the
   * client stream was already fully drained here and carries no more data
   * for ProxyEngine's own pipeline to forward.
   */
  function handleRequestBreakpoint(
    ctx: IContext,
    rule: Rule,
    exchange: CapturedExchange,
    callback: ErrorCallback,
  ): void {
    // Mirrors handleScriptRequestHook: `chunks` is the real (uncapped) body
    // that gets forwarded upstream once resumed; `displayCapture` is a
    // separate, capped copy purely for the dashboard's `exchange.requestBody`.
    // A single capped `BodyCapture` used for both (as this used to do) would
    // truncate the body actually sent to the server at MAX_CAPTURED_BODY_BYTES
    // for a request the user resumed without editing — see issue #95.
    const displayCapture = new BodyCapture();
    const chunks: Buffer[] = [];
    ctx.clientToProxyRequest.on('data', (chunk: Buffer) => {
      exchange.requestBodySize += chunk.length;
      displayCapture.add(chunk);
      chunks.push(chunk);
    });
    // See captureClientRequestBody's doc comment: without resuming the
    // (pre-paused) stream here, it never emits 'data'/'end' at all.
    ctx.clientToProxyRequest.resume();

    const pause = () => {
      displayCapture.applyTo(exchange, 'request');
      const rawBody = Buffer.concat(chunks);
      // `chunks` (via the still-registered 'data' listener's closure) and
      // `rawBody` would otherwise both hold the full body in memory at
      // once — for a large upload paused at a breakpoint, that's an
      // avoidable doubling of peak memory. The individual chunk Buffers can
      // be GC'd once `rawBody` (its single-buffer copy) exists.
      chunks.length = 0;

      const opts = ctx.proxyToServerRequestOptions;
      const payload: BreakpointRequestPayload = {
        phase: 'request',
        id: ctx.uuid,
        method: exchange.method,
        path: opts?.path ?? ctx.clientToProxyRequest.url ?? '/',
        headers: flattenHeaders(opts?.headers ?? ctx.clientToProxyRequest.headers),
        body: exchange.requestBody,
        // Read directly off `displayCapture` rather than the exchange field
        // it just set — a re-wrap of an already-capped buffer later (see the
        // `BodyCapture.of(finalBody)` below) must never be mistaken for this.
        bodyTruncated: displayCapture.isTruncated,
      };
      eventBus.emit('breakpointHit', { exchange: { ...exchange, breakpoint: 'request' }, payload });

      breakpoints.wait(ctx.uuid, 'request').then((command) => {
        if (command.action === 'abort') {
          inFlight.delete(ctx.uuid);
          ruleContexts.delete(ctx.uuid);
          exchange.error = `rule "${rule.name}": request aborted via breakpoint`;
          exchange.finishedAt = Date.now();
          exchange.durationMs = exchange.finishedAt - exchange.startedAt;
          eventBus.emit('response', exchange);
          ctx.proxyToClientResponse.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          ctx.proxyToClientResponse.end(`detour: request aborted via breakpoint rule "${rule.name}"`);
          // Deliberately never calls `callback`: leaving it uncalled is how
          // ProxyEngine is designed to skip forwarding to upstream.
          return;
        }

        const edits = command.edits;
        const finalBody = edits?.body !== undefined ? Buffer.from(edits.body, 'base64') : rawBody;

        if (opts) {
          if (edits?.method) opts.method = edits.method.toUpperCase();
          if (edits?.path) opts.path = edits.path;
          if (edits?.headers) opts.headers = { ...edits.headers };
          // The edited body's length may differ from the original; drop
          // content-length so Node sends it chunked instead (same as
          // installRequestBodyRewrite's callers do).
          delete opts.headers['content-length'];
          exchange.method = opts.method;
          exchange.url = `${ctx.isSSL ? 'https' : 'http'}://${exchange.host}${opts.path}`;
        }
        if (edits?.headers) exchange.requestHeaders = edits.headers;
        exchange.requestBodySize = finalBody.length;
        BodyCapture.of(finalBody).applyTo(exchange, 'request');

        ctx.onRequestData((_dataCtx, _chunk, cb) => cb(undefined, Buffer.alloc(0)));
        ctx.onRequestEnd((_endCtx, cb) => {
          if (finalBody.length > 0) ctx.proxyToServerRequest?.write(finalBody);
          eventBus.emit('request', exchange);
          return cb();
        });

        callback();
      });
    };

    if (ctx.clientToProxyRequest.complete) pause();
    else ctx.clientToProxyRequest.once('end', pause);
  }

  /**
   * Runs for every `script` rule at the request phase (issue #9), whether
   * or not its module actually defines `beforeRequest` — see the doc
   * comment on `scriptRequestBodies` for why: a `beforeResponse` hook must
   * always see the *real* request body, so the full body has to be
   * captured here unconditionally rather than only when there's a
   * transform to apply. Mirrors `handleRequestBreakpoint`'s shape (capture
   * the full body directly off `clientToProxyRequest`, then decide) rather
   * than the `rewrite` action's onRequestData/onRequestEnd streaming style:
   * a header/method change from the hook must land on
   * `proxyToServerRequestOptions` before the outer `callback` runs —
   * ProxyEngine creates the actual upstream request right after that (see
   * `makeProxyToServerRequest` in engine/proxyEngine.ts), so a change
   * applied any later would silently miss the request that already went
   * out. One consequence: unlike a plain forwarded request, a `script`
   * rule's (fully-buffered) upload never participates in Throttle's upload
   * simulation — the same trade-off `mock`/`breakpoint` already make.
   *
   * Deliberately does NOT reuse `captureClientRequestBody`/`BodyCapture` for
   * the body actually handed to the hook (and forwarded upstream): that
   * capture is capped at `MAX_CAPTURED_BODY_BYTES` for the dashboard's own
   * display copy, and per its doc comment the cap must never affect what's
   * actually proxied — silently truncating a large upload here would be
   * exactly that. `chunks` below is the real (uncapped) body; `displayCapture`
   * is a second, capped copy purely for `exchange.requestBody`.
   */
  function handleScriptRequestHook(
    ctx: IContext,
    matched: { rule: Rule; module: ScriptModule },
    exchange: CapturedExchange,
    callback: ErrorCallback,
  ): void {
    const { rule, module } = matched;
    const displayCapture = new BodyCapture();
    const chunks: Buffer[] = [];
    ctx.clientToProxyRequest.on('data', (chunk: Buffer) => {
      exchange.requestBodySize += chunk.length;
      displayCapture.add(chunk);
      chunks.push(chunk);
    });
    // See captureClientRequestBody's doc comment: without resuming the
    // (pre-paused) stream here, it never emits 'data'/'end' at all.
    ctx.clientToProxyRequest.resume();

    const forwardBody = (body: Buffer) => {
      // Handed to `beforeResponse` (if this rule also defines one) as its
      // `req.body` — see `scriptRequestBodies`' doc comment.
      scriptRequestBodies.set(ctx.uuid, body);
      ctx.onRequestData((_dataCtx, _chunk, cb) => cb(undefined, Buffer.alloc(0)));
      ctx.onRequestEnd((_endCtx, cb) => {
        if (body.length > 0) ctx.proxyToServerRequest?.write(body);
        eventBus.emit('request', exchange);
        return cb();
      });
      callback();
    };

    const run = () => {
      displayCapture.applyTo(exchange, 'request');
      const opts = ctx.proxyToServerRequestOptions;
      const body = Buffer.concat(chunks);
      if (!opts) {
        forwardBody(body);
        return;
      }

      const req: ScriptRequestInfo = {
        method: exchange.method,
        url: exchange.url,
        headers: flattenHeaders(opts.headers),
        body,
      };

      const applyResult = (result: ScriptRequestInfo) => {
        opts.method = result.method;
        opts.headers = { ...result.headers };
        // The (possibly rewritten) body's length is unknown up front — send
        // chunked instead, same as installRequestBodyRewrite. Case-
        // insensitive: a hook can spell it any way it likes, unlike headers
        // straight off the wire (always lowercased by Node).
        deleteHeader(opts.headers, 'content-length');
        exchange.method = result.method;
        // From `opts.headers` (post-delete), not `result.headers` — the
        // dashboard's own copy of what was sent must not show a
        // content-length that was actually stripped before forwarding.
        exchange.requestHeaders = opts.headers;
        exchange.requestBodySize = result.body.length;
        BodyCapture.of(result.body).applyTo(exchange, 'request');
        forwardBody(result.body);
      };

      runBeforeRequest(module, req)
        .then(applyResult)
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          eventBus.emit('error', {
            id: ctx.uuid,
            errorKind: 'RULE_SCRIPT_ERROR',
            message: `rule "${rule.name}": beforeRequest failed: ${message}`,
          });
          forwardBody(body); // Forward the original, untouched request rather than drop it.
        });
    };

    if (ctx.clientToProxyRequest.complete) run();
    else ctx.clientToProxyRequest.once('end', run);
  }

  /**
   * Pauses a response matched by a `breakpoint` rule (response phase) once
   * it's fully arrived from upstream but before any of it reaches the
   * client, and resumes/aborts it once the dashboard responds.
   *
   * Must run from the proxy-level `onResponseHeaders` hook (see
   * applyResponseHeaderRewrite's doc comment for why) — which is also the
   * only point status/headers can still be edited, since ProxyEngine
   * flushes them to the client immediately once this hook's callback fires.
   * Reads the upstream body directly off `serverToProxyResponse` (mirroring
   * handleRequestBreakpoint) so the full body is available before that
   * callback is released; once resumed, the (possibly edited) body is
   * written directly from `onResponseEnd` — mirroring
   * `installResponseBodyRewrite` — since the upstream stream was already
   * fully drained here.
   */
  function handleResponseBreakpoint(ctx: IContext, rule: Rule, callback: ErrorCallback): void {
    const exchange = inFlight.get(ctx.uuid);
    const res = ctx.serverToProxyResponse;
    if (!res || !exchange) {
      callback();
      return;
    }

    // Mirrors handleScriptResponseHook: `chunks` is the real (uncapped)
    // upstream body that gets forwarded to the client once resumed;
    // `displayCapture` is a separate, capped copy purely for the dashboard.
    // A single capped `BodyCapture` used for both (as this used to do) would
    // truncate the body actually sent to the client at MAX_CAPTURED_BODY_BYTES
    // for a response the user resumed without editing, and re-wrapping that
    // already-capped buffer for the snapshot would also silently launder
    // `responseBodyTruncated` back to `false` — see issue #95.
    const displayCapture = new BodyCapture();
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => {
      displayCapture.add(chunk);
      chunks.push(chunk);
    });
    // `serverToProxyResponse` is paused by ProxyEngine before this hook
    // runs; without resuming it here, it never emits 'data'/'end' and the
    // wait below deadlocks forever (same reasoning as the mock branch above).
    res.resume();

    const pause = () => {
      const rawBody = Buffer.concat(chunks);
      // See handleRequestBreakpoint's identical fix above: without this,
      // `chunks` and `rawBody` both hold the full response body in memory
      // at once for as long as this closure is alive.
      chunks.length = 0;
      const snapshot: CapturedExchange = { ...exchange, breakpoint: 'response' };
      snapshot.statusCode = res.statusCode;
      snapshot.statusMessage = res.statusMessage;
      snapshot.responseHeaders = { ...res.headers };
      snapshot.responseBodySize = rawBody.length;
      displayCapture.applyTo(snapshot, 'response');

      const payload: BreakpointResponsePayload = {
        phase: 'response',
        id: ctx.uuid,
        status: res.statusCode ?? 200,
        statusMessage: res.statusMessage,
        headers: flattenHeaders(res.headers),
        body: snapshot.responseBody,
        // Read directly off `displayCapture` — see the request phase's
        // identical fix above for why this must not go through a re-wrap of
        // an already-capped buffer.
        bodyTruncated: displayCapture.isTruncated,
      };
      eventBus.emit('breakpointHit', { exchange: snapshot, payload });

      breakpoints.wait(ctx.uuid, 'response').then((command) => {
        if (command.action === 'abort') {
          inFlight.delete(ctx.uuid);
          ruleContexts.delete(ctx.uuid);
          exchange.error = `rule "${rule.name}": response aborted via breakpoint (connection closed)`;
          exchange.finishedAt = Date.now();
          exchange.durationMs = exchange.finishedAt - exchange.startedAt;
          eventBus.emit('response', exchange);
          ctx.proxyToClientResponse.destroy();
          // Deliberately never calls `callback`: leaving it uncalled stops
          // headers/body from ever reaching the client, same convention as
          // the request-phase abort above.
          return;
        }

        const edits = command.edits;
        if (edits?.status !== undefined) res.statusCode = edits.status;
        if (edits?.statusMessage !== undefined) res.statusMessage = edits.statusMessage;
        if (edits?.headers) res.headers = { ...edits.headers };
        // Same reasoning as the request phase: the edited body's length may
        // differ, so drop content-length and let it go out chunked.
        delete res.headers['content-length'];
        const finalBody = edits?.body !== undefined ? Buffer.from(edits.body, 'base64') : rawBody;

        exchange.statusCode = res.statusCode;
        exchange.statusMessage = res.statusMessage;
        exchange.responseHeaders = { ...res.headers };
        exchange.responseBodySize = finalBody.length;
        BodyCapture.of(finalBody).applyTo(exchange, 'response');
        exchange.finishedAt = Date.now();
        exchange.durationMs = exchange.finishedAt - exchange.startedAt;

        ctx.onResponseData((_dataCtx, _chunk, cb) => cb(undefined, Buffer.alloc(0)));
        ctx.onResponseEnd((_endCtx, cb) => {
          if (finalBody.length > 0) ctx.proxyToClientResponse.write(finalBody);
          eventBus.emit('response', exchange);
          inFlight.delete(ctx.uuid);
          ruleContexts.delete(ctx.uuid);
          return cb();
        });

        callback();
      });
    };

    if (res.complete) pause();
    else res.once('end', pause);
  }

  /**
   * Runs a `script` rule's `beforeResponse` hook (issue #9), invoked from
   * `onResponseHeaders` — same reasoning as `applyResponseHeaderRewrite`/
   * `handleResponseBreakpoint`: status/headers can only still be edited
   * there, since ProxyEngine flushes them to the client the moment its
   * callback fires. Reads the upstream body directly off
   * `serverToProxyResponse` (mirroring `handleResponseBreakpoint`) so the
   * hook sees the full response before that callback is released; the
   * (possibly rewritten) body is then written from `onResponseEnd`, mirroring
   * `installResponseBodyRewrite`. `module` is passed in already-loaded (see
   * the `onResponse` handler below, which decided to route here in the
   * first place based on whether it defines `beforeResponse`).
   *
   * Deliberately accumulates the raw upstream body into a plain (uncapped)
   * `chunks` array rather than a capped `BodyCapture` — same reasoning as
   * `handleScriptRequestHook`: what's captured here is what's actually sent
   * back to the client, so it must never be silently truncated the way the
   * dashboard's own display copy is (see `finish`'s `BodyCapture.of` call,
   * which caps *that* copy on purpose).
   */
  function handleScriptResponseHook(ctx: IContext, rule: Rule, module: ScriptModule, callback: ErrorCallback): void {
    const exchange = inFlight.get(ctx.uuid);
    const res = ctx.serverToProxyResponse;
    if (!res || !exchange) {
      callback();
      return;
    }

    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.resume();

    // Applies a (possibly hook-rewritten) response and releases `callback`,
    // flushing status/headers to the client. Shared by the success and
    // error paths below, mirroring `handleResponseBreakpoint`'s `resume`.
    const finish = (result: ScriptResponseInfo) => {
      res.statusCode = result.status;
      res.statusMessage = result.statusMessage;
      res.headers = { ...result.headers };
      // The final body's length may differ from upstream's — drop
      // content-length and let it go out chunked, same as elsewhere.
      // Case-insensitive: see the request-phase hook's identical fix.
      deleteHeader(res.headers, 'content-length');

      exchange.statusCode = result.status;
      exchange.statusMessage = result.statusMessage;
      // From `res.headers` (post-delete), not `result.headers` — same
      // reasoning as the request-phase hook's identical fix.
      exchange.responseHeaders = { ...res.headers };
      exchange.responseBodySize = result.body.length;
      BodyCapture.of(result.body).applyTo(exchange, 'response');
      exchange.finishedAt = Date.now();
      exchange.durationMs = exchange.finishedAt - exchange.startedAt;

      ctx.onResponseData((_dataCtx, _chunk, cb) => cb(undefined, Buffer.alloc(0)));
      ctx.onResponseEnd((_endCtx, cb) => {
        if (result.body.length > 0) ctx.proxyToClientResponse.write(result.body);
        eventBus.emit('response', exchange);
        inFlight.delete(ctx.uuid);
        ruleContexts.delete(ctx.uuid);
        return cb();
      });
      callback();
    };

    const run = () => {
      // The exact body `handleScriptRequestHook` forwarded upstream for
      // this same exchange — see `scriptRequestBodies`' doc comment. Falls
      // back to the dashboard's own (possibly truncated) display copy only
      // in the rare case that path never ran at all, e.g. the module
      // failed to load at the request phase but a fixed version loads
      // successfully by the time this (independent) response-phase load
      // runs — see the `onRequest` handler's script branch.
      const requestBody = scriptRequestBodies.get(ctx.uuid);
      scriptRequestBodies.delete(ctx.uuid);
      const reqInfo: ScriptRequestInfo = {
        method: exchange.method,
        url: exchange.url,
        headers: flattenHeaders(exchange.requestHeaders),
        body: requestBody ?? (exchange.requestBody ? Buffer.from(exchange.requestBody, 'base64') : Buffer.alloc(0)),
      };
      const resInfo: ScriptResponseInfo = {
        status: res.statusCode ?? 200,
        statusMessage: res.statusMessage,
        // Preserves a multi-value header (e.g. `set-cookie`) as an array —
        // see `compactHeaders`' doc comment for why `flattenHeaders`
        // (comma-joining) would corrupt it.
        headers: compactHeaders(res.headers),
        body: Buffer.concat(chunks),
      };

      runBeforeResponse(module, reqInfo, resInfo)
        .then(finish)
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          eventBus.emit('error', {
            id: ctx.uuid,
            errorKind: 'RULE_SCRIPT_ERROR',
            message: `rule "${rule.name}": beforeResponse failed: ${message}`,
          });
          finish(resInfo); // Forward the original, untouched response rather than drop it.
        });
    };

    if (res.complete) run();
    else res.once('end', run);
  }

  // Response header/status rewrites must run before ProxyEngine flushes
  // them to the client — see applyResponseHeaderRewrite's doc comment.
  proxy.onResponseHeaders((ctx, callback) => {
    const rule = ruleContexts.get(ctx.uuid);
    if (rule?.action.type === 'breakpoint' && rule.action.response !== false) {
      handleResponseBreakpoint(ctx, rule, callback);
      return;
    }
    if (rule?.action.type === 'script') {
      const module = scriptModules.get(ctx.uuid);
      scriptModules.delete(ctx.uuid);
      if (module) {
        handleScriptResponseHook(ctx, rule, module, callback);
        return;
      }
    }
    if (rule?.action.type === 'rewrite' && rule.action.response) {
      applyResponseHeaderRewrite(ctx, rule.action.response);
    }
    return callback();
  });

  proxy.onRequest((ctx, callback) => {
    // The entire request handler — rule matching, mock/breakpoint/route/
    // rewrite, and forwarding to upstream — runs behind Throttle's one-time
    // per-exchange latency delay (see `ThrottleState`'s doc comment), so
    // every code path below (including a `mock` rule's own response) shares
    // the same simulated round-trip cost.
    const run = () => {
      const { url, host: reqHost } = resolveUrl(ctx);
      const method = ctx.clientToProxyRequest.method ?? 'GET';

      if (isHostBlocked(blockHostsState.hosts, reqHost)) {
        const exchange = buildBaseExchange(ctx, {
          url,
          method,
          host: reqHost,
          ruleName: `block-hosts (${blockHostsState.mode})`,
        });
        inFlight.set(ctx.uuid, exchange);
        // A blocked request never forwards to upstream (callback() is never
        // called below), so the usual onRequestData/onRequestEnd hooks never
        // run for it — capture the client's raw request stream directly
        // instead, same as the `mock` branch below.
        const requestCapture = captureClientRequestBody(ctx, exchange);
        const respondBlocked = () => {
          requestCapture.applyTo(exchange, 'request');
          if (blockHostsState.mode === 'reset') {
            sendMockSimulate(ctx, 'close');
            eventBus.emit('request', exchange);
            exchange.error = `blocked host "${reqHost}": simulated connection close (no response sent)`;
            exchange.finishedAt = Date.now();
            exchange.durationMs = exchange.finishedAt - exchange.startedAt;
            eventBus.emit('response', exchange);
            inFlight.delete(ctx.uuid);
            return;
          }
          const mock: MockResponse = {
            status: 403,
            statusMessage: 'Forbidden',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: Buffer.from(`detour: request to "${reqHost}" blocked by Block Hosts\n`, 'utf8'),
          };
          sendMockResponse(ctx, mock);
          exchange.statusCode = mock.status;
          exchange.statusMessage = mock.statusMessage;
          exchange.responseHeaders = mock.headers;
          exchange.responseBodySize = mock.body.length;
          BodyCapture.of(mock.body).applyTo(exchange, 'response');
          exchange.finishedAt = Date.now();
          exchange.durationMs = exchange.finishedAt - exchange.startedAt;
          eventBus.emit('request', exchange);
          eventBus.emit('response', exchange);
          inFlight.delete(ctx.uuid);
        };
        if (ctx.clientToProxyRequest.complete) {
          respondBlocked();
        } else {
          ctx.clientToProxyRequest.once('end', respondBlocked);
        }
        // Deliberately does not call `callback()`: leaving it uncalled is how
        // ProxyEngine is designed to skip forwarding to upstream.
        return;
      }

      // While intercept is off (globally, or for this host via Focus), only a
      // `route` rule keeps applying (see `interceptEnabled`'s doc comment
      // above) — mock/rewrite/breakpoint rules are treated as if nothing
      // matched, so the request flows through untouched.
      const rule = resolveExchangeAction(ruleEngine, { method, url, host: reqHost, interceptEnabled, focusHosts });

      const exchange = buildBaseExchange(ctx, { url, method, host: reqHost, ruleName: rule?.name });
      inFlight.set(ctx.uuid, exchange);

      if (rule?.action.type === 'mock') {
        const mockAction = rule.action;
        const simulate = mockAction.simulate;
        let mockError: string | undefined;
        const mock = simulate
          ? undefined
          : tryResolveMock(rule, ruleEngine!.basePath, ruleEngine!.allowExternalScriptPaths, (message) => {
              mockError = message;
            });

        // A mock never forwards to upstream (callback() is never called
        // below), so the usual onRequestData/onRequestEnd hooks — which only
        // fire as part of that forwarding pipeline — never run for it. Capture
        // the client's raw request stream directly instead, so the dashboard
        // still shows what was actually sent to a mocked endpoint.
        const requestCapture = captureClientRequestBody(ctx, exchange);

        const respond = () => {
          requestCapture.applyTo(exchange, 'request');

          if (simulate) {
            sendMockSimulate(ctx, simulate);
            eventBus.emit('request', exchange);
            if (simulate === 'close') {
              // Unlike 'timeout' (which just leaves the client hanging, with
              // nothing further to report), a closed connection is a
              // definite, reportable outcome — flag it on the exchange the
              // same way a real connection reset would show up, rather than
              // only as a separate proxy-level 'error' event.
              exchange.error = `rule "${rule.name}": simulated connection close (no response sent)`;
              exchange.finishedAt = Date.now();
              exchange.durationMs = exchange.finishedAt - exchange.startedAt;
              eventBus.emit('response', exchange);
            }
            // 'timeout' deliberately never emits 'response': the exchange
            // stays "pending" in the dashboard for as long as the connection
            // stays open, same as a real server that stopped responding.
            inFlight.delete(ctx.uuid);
            return;
          }

          sendMockResponse(ctx, mock as MockResponse);
          exchange.statusCode = (mock as MockResponse).status;
          exchange.statusMessage = (mock as MockResponse).statusMessage;
          exchange.responseHeaders = (mock as MockResponse).headers;
          exchange.responseBodySize = (mock as MockResponse).body.length;
          BodyCapture.of((mock as MockResponse).body).applyTo(exchange, 'response');
          exchange.finishedAt = Date.now();
          exchange.durationMs = exchange.finishedAt - exchange.startedAt;
          exchange.error = mockError;
          eventBus.emit('request', exchange);
          eventBus.emit('response', exchange);
          inFlight.delete(ctx.uuid);
        };
        if (mockError) {
          eventBus.emit('error', {
            id: ctx.uuid,
            errorKind: 'RULE_MOCK_ERROR',
            message: `rule "${rule.name}": ${mockError}`,
          });
        }
        const sendMockAfterDelay = () => {
          const delayMs = mockAction.delayMs;
          if (delayMs && delayMs > 0) {
            setTimeout(respond, delayMs);
          } else {
            respond();
          }
        };
        // Wait for the request body to finish arriving (if it hasn't
        // already) so it's fully captured before responding — sendMockResponse
        // drains/discards whatever's left on the socket regardless.
        if (ctx.clientToProxyRequest.complete) {
          sendMockAfterDelay();
        } else {
          ctx.clientToProxyRequest.once('end', sendMockAfterDelay);
        }
        // Deliberately does not call `callback()`: leaving it uncalled is
        // how ProxyEngine is designed to skip forwarding to upstream.
        return;
      }

      if (rule?.action.type === 'breakpoint' && rule.action.request !== false) {
        ruleContexts.set(ctx.uuid, rule);
        handleRequestBreakpoint(ctx, rule, exchange, callback);
        return;
      }

      if (rule?.action.type === 'script') {
        ruleContexts.set(ctx.uuid, rule);
        const module = tryLoadScriptModule(
          rule,
          ruleEngine!.basePath,
          ruleEngine!.allowExternalScriptPaths,
          (message) => eventBus.emit('error', { id: ctx.uuid, errorKind: 'RULE_SCRIPT_ERROR', message }),
        );
        // Always runs (not just when `beforeRequest` is defined) — a
        // `beforeResponse` hook (checked separately at the response phase)
        // needs the real, full request body as its `req` argument, which
        // only this path captures; see `scriptRequestBodies`' doc comment.
        if (module) {
          handleScriptRequestHook(ctx, { rule, module }, exchange, callback);
          return;
        }
        // The module failed to load — forward unchanged; `onResponse`/
        // `onResponseHeaders` below independently try loading it again for
        // `beforeResponse` (see `tryLoadScriptModule`'s mtime-based cache —
        // this is cheap, and lets a fixed script recover without a restart).
      }

      if (rule) ruleContexts.set(ctx.uuid, rule);
      if (rule?.action.type === 'route') {
        applyRouteAction(ctx, rule.action);
      } else if (rule?.action.type === 'rewrite' && rule.action.request) {
        applyRequestRewrite(ctx, rule.action.request);
      }

      const requestCapture = new BodyCapture();
      // Throttle's upload bandwidth cap/packet-loss simulation, applied
      // per-chunk as it streams through — ProxyEngine (unlike
      // http-mitm-proxy, issue #42) genuinely awaits a delayed
      // onRequestData callback before forwarding the next chunk, so a real
      // `setTimeout` here holds up the whole pipe exactly like
      // `throttleTransform.ts`'s Transform does for the CONNECT-tunnel
      // passthrough path. Skipped when a `rewrite` rule is also rewriting
      // this body: that rule's own onRequestData hook (registered earlier,
      // see `applyRequestRewrite` above) already reduces every chunk this
      // hook sees to empty, so there'd be nothing left to throttle anyway.
      const throttleUpload =
        throttleState.enabled &&
        (throttleState.upKbps > 0 || throttleState.packetLossPct > 0) &&
        !(rule?.action.type === 'rewrite' && rule.action.request?.body);
      const upBandwidth = new BandwidthState();
      ctx.onRequestData((_dataCtx, chunk, cb) => {
        exchange.requestBodySize += chunk.length;
        requestCapture.add(chunk);
        if (!throttleUpload) return cb(undefined, chunk);
        const delay = transferDelayMs(chunk.length, throttleState.upKbps, throttleState.packetLossPct, upBandwidth);
        if (delay > 0) setTimeout(() => cb(undefined, chunk), delay);
        else cb(undefined, chunk);
      });

      ctx.onRequestEnd((_endCtx, cb) => {
        requestCapture.applyTo(exchange, 'request');
        // Published as soon as the request is fully sent, before the
        // response arrives — lets consumers (e.g. the dashboard) show a
        // request as "pending" while it's in flight.
        eventBus.emit('request', exchange);
        cb();
      });

      return callback();
    };

    const latency = throttleState.enabled ? throttleState.latencyMs : 0;
    if (latency > 0) setTimeout(run, latency);
    else run();
  });

  proxy.onResponse((ctx, callback) => {
    const exchange = inFlight.get(ctx.uuid);
    const rule = ruleContexts.get(ctx.uuid);

    if (rule?.action.type === 'breakpoint' && rule.action.response !== false) {
      // Fully handled by handleResponseBreakpoint from the onResponseHeaders
      // hook instead, which needs to pause *before* headers are flushed —
      // skip the normal capture/bookkeeping below entirely so it isn't done
      // twice (once here with an empty body, once there with the real one).
      return callback();
    }

    if (rule?.action.type === 'script') {
      // Load (or reuse the cached) module now to decide whether this rule
      // even has a `beforeResponse` hook — a rule with only `beforeRequest`
      // has nothing left to do at the response phase and falls through to
      // the normal capture/forwarding below, same as a `route`/no-op rule.
      const module = tryLoadScriptModule(rule, ruleEngine!.basePath, ruleEngine!.allowExternalScriptPaths, (message) =>
        eventBus.emit('error', { id: ctx.uuid, errorKind: 'RULE_SCRIPT_ERROR', message }),
      );
      if (module?.beforeResponse) {
        scriptModules.set(ctx.uuid, module);
        // Fully handled by handleScriptResponseHook from onResponseHeaders
        // instead (needs the response *before* headers are flushed — see
        // its doc comment), mirroring the breakpoint skip just above.
        return callback();
      }
      // No `beforeResponse` (or the module failed to load) — nothing will
      // consume the full request body `handleScriptRequestHook` stashed
      // for it (see `scriptRequestBodies`' doc comment); drop it here
      // rather than leak it until `onError`.
      scriptRequestBodies.delete(ctx.uuid);
    }

    if (exchange && ctx.serverToProxyResponse) {
      exchange.statusCode = ctx.serverToProxyResponse.statusCode;
      exchange.statusMessage = ctx.serverToProxyResponse.statusMessage;
      exchange.responseHeaders = { ...ctx.serverToProxyResponse.headers };
    }

    const responseCapture = new BodyCapture();
    // Throttle's download bandwidth cap/packet-loss simulation, applied
    // per-chunk as it streams to the client — see the upload side's
    // identical comment in `proxy.onRequest` above. Skipped when a
    // `rewrite` rule is also rewriting this body: its own onResponseData
    // hook is registered *after* this one (right below), so if this hook
    // reduced every chunk to empty first, the rewrite would see nothing to
    // rewrite.
    const throttleDownload =
      throttleState.enabled &&
      (throttleState.downKbps > 0 || throttleState.packetLossPct > 0) &&
      !(rule?.action.type === 'rewrite' && rule.action.response?.body);
    const downBandwidth = new BandwidthState();
    ctx.onResponseData((_dataCtx, chunk, cb) => {
      if (exchange) {
        exchange.responseBodySize += chunk.length;
        responseCapture.add(chunk);
      }
      if (!throttleDownload) return cb(undefined, chunk);
      const delay = transferDelayMs(chunk.length, throttleState.downKbps, throttleState.packetLossPct, downBandwidth);
      if (delay > 0) setTimeout(() => cb(undefined, chunk), delay);
      else cb(undefined, chunk);
    });

    if (rule?.action.type === 'rewrite' && rule.action.response?.body) {
      installResponseBodyRewrite(ctx, rule.action.response.body, (finalSize) => {
        if (exchange) exchange.responseBodySize = finalSize;
      });
    }

    ctx.onResponseEnd((_endCtx, cb) => {
      if (exchange) {
        // Reflect a status rewrite applied in the onResponseHeaders hook above.
        if (ctx.serverToProxyResponse) exchange.statusCode = ctx.serverToProxyResponse.statusCode;
        exchange.finishedAt = Date.now();
        exchange.durationMs = exchange.finishedAt - exchange.startedAt;
        // Captures the pre-rewrite body (mirroring responseBodySize's
        // accounting above) — the dashboard shows what actually came from
        // upstream, not what a rewrite rule replaced it with.
        responseCapture.applyTo(exchange, 'response');
        eventBus.emit('response', exchange);
        inFlight.delete(ctx.uuid);
      }
      ruleContexts.delete(ctx.uuid);
      cb();
    });

    return callback();
  });

  return new Promise((resolve, reject) => {
    try {
      proxy.listen({ port: options.port, host, sslCaDir, http2: options.http2Enabled ?? true }, () => {
        resolve({
          port: proxy.httpPort,
          caCertPath: proxy.ca.getCACertPath(),
          stop: () =>
            new Promise<void>((res) => {
              eventBus.off('breakpointResume', handleBreakpointResume);
              eventBus.off('setIntercept', handleSetIntercept);
              eventBus.off('setFocus', handleSetFocus);
              eventBus.off('setThrottle', handleSetThrottle);
              eventBus.off('setBlockHosts', handleSetBlockHosts);
              ruleEngine?.close();
              proxy.close();
              res();
            }),
        });
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
