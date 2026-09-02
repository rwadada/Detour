import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { Proxy } from 'http-mitm-proxy';
import type { ErrorCallback, IContext } from 'http-mitm-proxy';
import { isHostBlocked, normalizeBlockHosts } from '../../domain/blockHosts/blockHostsPolicy';
import { BodyCapture } from '../../domain/exchange/bodyCapture';
import { flattenHeaders } from '../../domain/exchange/headers';
import type {
  BlockHostsState,
  BreakpointRequestPayload,
  BreakpointResponsePayload,
  BreakpointResumeCommand,
  CapturedExchange,
  ThrottleState,
} from '../../domain/exchange/types';
import { formatHostPort, isHostFocused, normalizeFocusHosts } from '../../domain/focus/focusPolicy';
import type { Rule } from '../../domain/rules/types';
import { BandwidthState, flushThrottledBody, transferDelayMs } from '../../domain/throttle/bandwidth';
import { DEFAULT_THROTTLE_STATE, normalizeThrottleState } from '../../domain/throttle/throttlePolicy';
import { BreakpointCoordinator } from '../../usecase/breakpointCoordinator';
import { resolveConnectRoute } from '../../usecase/resolveConnectRoute';
import { resolveExchangeAction } from '../../usecase/resolveExchangeAction';
import type { RuleEngine } from '../../usecase/ruleEngine';
import { resolveCertDir } from '../certStore';
import type { DetourEventBus } from '../eventBus';
import { assertPortAvailable } from '../portCheck';
import {
  applyRequestRewrite,
  applyResponseHeaderRewrite,
  applyRouteAction,
  installResponseBodyRewrite,
  resolveMockResponse,
  sendMockResponse,
  sendMockSimulate,
  type MockResponse,
} from './actionsRuntime';
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
  // http-mitm-proxy calls ctx.clientToProxyRequest.pause() before onRequest
  // runs; adding a 'data' listener alone does NOT auto-resume a stream that
  // was explicitly paused (see Readable.prototype.on in Node's stream
  // internals), so without this, the request stream never emits 'data'/'end'
  // and a caller waiting on it would deadlock forever.
  ctx.clientToProxyRequest.resume();
  return requestCapture;
}

export interface ProxyServerOptions {
  port: number;
  host?: string;
  /** When set, requests are matched against rules.json (mock/route/rewrite) before/while proxying. */
  ruleEngine?: RuleEngine;
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
 * By the time our onRequest handler runs, http-mitm-proxy has already
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
function tryResolveMock(rule: Rule, basePath: string, onError: (message: string) => void): MockResponse {
  try {
    return resolveMockResponse(rule.action as Extract<Rule['action'], { type: 'mock' }>, basePath);
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

  const proxy = new Proxy();
  const sslCaDir = resolveCertDir();
  const ruleEngine = options.ruleEngine;
  // Keyed by ctx.uuid so the request-phase and response-phase handlers
  // (which fire as separate callbacks) can agree on the same exchange.
  const inFlight = new Map<string, CapturedExchange>();
  // Keyed by ctx.uuid so the response-phase handlers know which rule (if
  // any) matched this request — matching itself only happens once, in
  // onRequest, since it's the same for both.
  const ruleContexts = new Map<string, Rule>();

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
   * without decrypting), but nothing else about the connection is observable
   * or editable.
   */
  function handleInterceptOffConnect(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = Proxy.parseHostAndPort(req, 443);
    if (!target?.host) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const originalPort = target.port ?? 443;
    const route = resolveConnectRoute(ruleEngine, target.host, originalPort);
    const destHost = route?.host ?? target.host;
    const destPort = route?.port ?? originalPort;

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
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', (err) => {
      eventBus.emit('error', {
        errorKind: 'INTERCEPT_OFF_TUNNEL_ERROR',
        message: `passthrough tunnel to ${destHost}:${destPort} failed: ${err.message}`,
      });
      if (!established && !socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    socket.on('error', teardown);
    socket.once('close', teardown);
    upstream.once('close', teardown);
  }

  proxy.onConnect((req, socket, head, callback) => {
    // An unparseable target can't be checked against Block Hosts/Focus —
    // fall through to the normal intercept-enabled path (same as before
    // this feature), rather than treating "can't tell" as blocked/unfocused.
    const target = Proxy.parseHostAndPort(req, 443);
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

  proxy.onError((ctx, err, errorKind) => {
    if (ctx) {
      inFlight.delete(ctx.uuid);
      ruleContexts.delete(ctx.uuid);
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
   * for http-mitm-proxy's own pipeline to forward.
   */
  function handleRequestBreakpoint(
    ctx: IContext,
    rule: Rule,
    exchange: CapturedExchange,
    callback: ErrorCallback,
  ): void {
    const requestCapture = captureClientRequestBody(ctx, exchange);

    const pause = () => {
      requestCapture.applyTo(exchange, 'request');

      const opts = ctx.proxyToServerRequestOptions;
      const payload: BreakpointRequestPayload = {
        phase: 'request',
        id: ctx.uuid,
        method: exchange.method,
        path: opts?.path ?? ctx.clientToProxyRequest.url ?? '/',
        headers: flattenHeaders(opts?.headers ?? ctx.clientToProxyRequest.headers),
        body: exchange.requestBody,
        bodyTruncated: exchange.requestBodyTruncated ?? false,
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
          // http-mitm-proxy is designed to skip forwarding to upstream.
          return;
        }

        const edits = command.edits;
        const finalBody = edits?.body !== undefined ? Buffer.from(edits.body, 'base64') : requestCapture.toBuffer();

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
   * Pauses a response matched by a `breakpoint` rule (response phase) once
   * it's fully arrived from upstream but before any of it reaches the
   * client, and resumes/aborts it once the dashboard responds.
   *
   * Must run from the proxy-level `onResponseHeaders` hook (see
   * applyResponseHeaderRewrite's doc comment for why) — which is also the
   * only point status/headers can still be edited, since http-mitm-proxy
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

    const capture = new BodyCapture();
    res.on('data', (chunk: Buffer) => capture.add(chunk));
    // `serverToProxyResponse` is paused by http-mitm-proxy before this hook
    // runs; without resuming it here, it never emits 'data'/'end' and the
    // wait below deadlocks forever (same reasoning as the mock branch above).
    res.resume();

    const pause = () => {
      const rawBody = capture.toBuffer();
      const snapshot: CapturedExchange = { ...exchange, breakpoint: 'response' };
      snapshot.statusCode = res.statusCode;
      snapshot.statusMessage = res.statusMessage;
      snapshot.responseHeaders = { ...res.headers };
      snapshot.responseBodySize = rawBody.length;
      BodyCapture.of(rawBody).applyTo(snapshot, 'response');

      const payload: BreakpointResponsePayload = {
        phase: 'response',
        id: ctx.uuid,
        status: res.statusCode ?? 200,
        statusMessage: res.statusMessage,
        headers: flattenHeaders(res.headers),
        body: snapshot.responseBody,
        bodyTruncated: snapshot.responseBodyTruncated ?? false,
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

  // Response header/status rewrites must run before http-mitm-proxy
  // flushes them to the client. This has to be registered at the proxy
  // level (not via `ctx.onResponseHeaders`, which the library never
  // actually invokes) — see applyResponseHeaderRewrite's doc comment.
  proxy.onResponseHeaders((ctx, callback) => {
    const rule = ruleContexts.get(ctx.uuid);
    if (rule?.action.type === 'breakpoint' && rule.action.response !== false) {
      handleResponseBreakpoint(ctx, rule, callback);
      return;
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
        // http-mitm-proxy is designed to skip forwarding to upstream.
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
          : tryResolveMock(rule, ruleEngine!.basePath, (message) => {
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
        // how http-mitm-proxy is designed to skip forwarding to upstream.
        return;
      }

      if (rule?.action.type === 'breakpoint' && rule.action.request !== false) {
        ruleContexts.set(ctx.uuid, rule);
        handleRequestBreakpoint(ctx, rule, exchange, callback);
        return;
      }

      if (rule) ruleContexts.set(ctx.uuid, rule);
      if (rule?.action.type === 'route') {
        applyRouteAction(ctx, rule.action);
      } else if (rule?.action.type === 'rewrite' && rule.action.request) {
        applyRequestRewrite(ctx, rule.action.request);
      }

      const requestCapture = new BodyCapture();
      // Throttle's upload bandwidth cap/packet-loss simulation. A per-chunk
      // delayed forward (`cb(undefined, chunk)` called late) doesn't work
      // here: http-mitm-proxy's internal request filter finalizes the
      // upstream request as soon as the client's own stream ends, without
      // waiting for an outstanding onRequestData callback from an earlier
      // chunk (see `ProxyFinalRequestFilter.end()` in http-mitm-proxy) — a
      // delayed chunk can be silently dropped instead of just arriving
      // late. So instead the whole body is buffered here and flushed as one
      // write from onRequestEnd below (whose callback IS properly awaited
      // before the request is finalized), after a delay proportional to its
      // total size — the same buffer-then-flush shape
      // infra/proxy/actionsRuntime.ts's installRequestBodyRewrite uses, for
      // the same reason. Skipped when a `rewrite` rule is also rewriting
      // this body: that rule's own onRequestData hook (registered earlier,
      // see `applyRequestRewrite` above) already reduces every chunk this
      // hook sees to empty, so there'd be nothing left to throttle anyway.
      const throttleUpload =
        throttleState.enabled &&
        (throttleState.upKbps > 0 || throttleState.packetLossPct > 0) &&
        !(rule?.action.type === 'rewrite' && rule.action.request?.body);
      const upBandwidth = new BandwidthState();
      const uploadChunks: Buffer[] = [];
      ctx.onRequestData((_dataCtx, chunk, cb) => {
        exchange.requestBodySize += chunk.length;
        requestCapture.add(chunk);
        if (!throttleUpload) return cb(undefined, chunk);
        uploadChunks.push(chunk);
        return cb(undefined, Buffer.alloc(0));
      });

      ctx.onRequestEnd((_endCtx, cb) => {
        requestCapture.applyTo(exchange, 'request');
        // Published as soon as the request is fully sent, before the
        // response arrives — lets consumers (e.g. the dashboard) show a
        // request as "pending" while it's in flight.
        eventBus.emit('request', exchange);
        if (!throttleUpload || uploadChunks.length === 0) return cb();
        const body = Buffer.concat(uploadChunks);
        const delay = transferDelayMs(body.length, throttleState.upKbps, throttleState.packetLossPct, upBandwidth);
        flushThrottledBody(body, delay, (b) => ctx.proxyToServerRequest?.write(b), cb);
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

    if (exchange && ctx.serverToProxyResponse) {
      exchange.statusCode = ctx.serverToProxyResponse.statusCode;
      exchange.statusMessage = ctx.serverToProxyResponse.statusMessage;
      exchange.responseHeaders = { ...ctx.serverToProxyResponse.headers };
    }

    const responseCapture = new BodyCapture();
    // Throttle's download bandwidth cap/packet-loss simulation — same
    // buffer-then-flush shape as the upload side in onRequest above (see
    // its comment for why per-chunk delayed forwarding doesn't work with
    // this library), flushed from onResponseEnd below instead. Skipped when
    // a `rewrite` rule is also rewriting this body: its own onResponseData
    // hook is registered *after* this one (right below), so if this hook
    // reduced every chunk to empty first, the rewrite would see nothing to
    // rewrite.
    const throttleDownload =
      throttleState.enabled &&
      (throttleState.downKbps > 0 || throttleState.packetLossPct > 0) &&
      !(rule?.action.type === 'rewrite' && rule.action.response?.body);
    const downBandwidth = new BandwidthState();
    const downloadChunks: Buffer[] = [];
    ctx.onResponseData((_dataCtx, chunk, cb) => {
      if (exchange) {
        exchange.responseBodySize += chunk.length;
        responseCapture.add(chunk);
      }
      if (!throttleDownload) return cb(undefined, chunk);
      downloadChunks.push(chunk);
      return cb(undefined, Buffer.alloc(0));
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
      if (!throttleDownload || downloadChunks.length === 0) return cb();
      const body = Buffer.concat(downloadChunks);
      const delay = transferDelayMs(body.length, throttleState.downKbps, throttleState.packetLossPct, downBandwidth);
      flushThrottledBody(body, delay, (b) => ctx.proxyToClientResponse.write(b), cb);
    });

    return callback();
  });

  return new Promise((resolve, reject) => {
    try {
      proxy.listen({ port: options.port, host, sslCaDir }, () => {
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
