import { isHostBlocked, normalizeBlockHosts } from '../../domain/blockHosts/blockHostsPolicy';
import { BodyCapture } from '../../domain/exchange/bodyCapture';
import type {
  BlockHostsState,
  BreakpointResumeCommand,
  CapturedExchange,
  CapturedWebSocketConnection,
  ThrottleState,
} from '../../domain/exchange/types';
import { normalizeFocusHosts } from '../../domain/focus/focusPolicy';
import type { ScriptModule } from '../../domain/rules/scriptAction';
import type { Rule } from '../../domain/rules/types';
import { BandwidthState, transferDelayMs } from '../../domain/throttle/bandwidth';
import { DEFAULT_THROTTLE_STATE, normalizeThrottleState } from '../../domain/throttle/throttlePolicy';
import { applyResponseRewritesToMock } from '../../usecase/applyResponseRewritesToMock';
import { BreakpointCoordinator } from '../../usecase/breakpointCoordinator';
import { resolveBlockedRequestOutcome } from '../../usecase/resolveBlockedRequestOutcome';
import { resolveExchangeAction } from '../../usecase/resolveExchangeAction';
import { selectLastMatchingBodyRewriteRule } from '../../usecase/selectBodyRewriteRule';
import type { RuleEngine } from '../../usecase/ruleEngine';
import { resolveCertDir } from '../certStore';
import type { DetourEventBus } from '../eventBus';
import { assertPortAvailable } from '../portCheck';
import { nodeCommandRunner } from '../process/nodeCommandRunner';
import {
  applyRequestRewrite,
  applyRouteAction,
  sendMockResponse,
  sendMockSimulate,
  type MockResponse,
} from './actionsRuntime';
import { ClientProcessDirectory, isClientProcessLookupSupported } from './clientProcessLookup';
import { ProxyEngine } from './engine/proxyEngine';
import type { IContext } from './engine/types';
import { createConnectHandler } from './pipeline/connectHandler';
import { createInterceptOffConnectHandler } from './pipeline/interceptOffConnect';
import { createProxyErrorHandler } from './pipeline/proxyErrorHandler';
import { createRequestBreakpointHandler } from './pipeline/requestBreakpoint';
import { createResponseHandler } from './pipeline/responseHandler';
import { createResponseBreakpointHandler } from './pipeline/responseBreakpoint';
import { createResponseHeadersHandler } from './pipeline/responseHeadersHandler';
import { createScriptRequestHookHandler } from './pipeline/scriptRequestHook';
import { createScriptResponseHookHandler } from './pipeline/scriptResponseHook';
import { createWebSocketHandlers } from './pipeline/webSocketHandlers';
import { tryLoadScriptModule, tryResolveMock } from './scriptModuleLoader';

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
  /**
   * Routes every proxy→upstream connection through this HTTP(S)/SOCKS proxy
   * instead of connecting to the real destination directly (issue #145) —
   * see `ProxyEngineOptions.upstreamProxyUrl`'s doc comment. Already
   * validated by the caller (`cli.ts`). Omit for direct connections.
   */
  upstreamProxyUrl?: string;
}

export interface ProxyServerHandle {
  /** Port the proxy actually bound to (relevant when options.port is 0). */
  port: number;
  /** Path to the auto-generated root CA, for the user to install/trust. */
  caCertPath: string;
  /**
   * Wires a `RuleEngine` into an already-running proxy that started without
   * one (`options.ruleEngine` was `undefined`) — every request/CONNECT
   * handler below reads the engine through a closure variable rather than
   * `options.ruleEngine` directly, so calling this makes already-matched
   * rule types (mock/route/rewrite/script) apply to traffic from this point
   * on, with no restart. Used by `cli.ts` to hand the dashboard's
   * lazily-created engine (issue #123 — applying a Rule Profile with no
   * `--rules`/auto-detected file yet configured) to the proxy that's
   * actually serving traffic, since the two are otherwise independent
   * modules that would each end up with their own engine instance
   * disagreeing about what's active. Overwrites any previously-set engine
   * rather than merging — there's only ever meant to be one active at a
   * time.
   */
  setRuleEngine(engine: RuleEngine): void;
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

/** Builds the initial `CapturedExchange` for a request just as it starts, before its outcome (blocked/mock/route/rewrite/forwarded) is known. Shared by the Block Hosts branch and the normal rule-resolution path in `proxy.onRequest` below. */
function buildBaseExchange(
  ctx: IContext,
  info: { url: string; method: string; host: string; ruleName: string | undefined },
  clientProcessDirectory: ClientProcessDirectory | undefined,
): CapturedExchange {
  const exchange: CapturedExchange = {
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
  // Synchronous (issue #147) — reads whatever background-polled snapshot
  // `clientProcessDirectory` already has in hand (see its own doc comment
  // for why this can't be an async per-request lookup instead: a Block
  // Hosts/`mock` response's `request`/`response` events can both fire in
  // this very same tick, with no later "exchange updated" message this
  // event bus's protocol has room for). `undefined` on non-macOS hosts.
  if (clientProcessDirectory) {
    const { remoteAddress, remotePort } = ctx.clientToProxyRequest.socket;
    if (remoteAddress !== undefined && remotePort !== undefined) {
      const clientProcess = clientProcessDirectory.lookup(remoteAddress, remotePort);
      if (clientProcess) exchange.clientProcess = clientProcess;
    }
  }
  return exchange;
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
  // `let`, not `const`: `setRuleEngine` (see `ProxyServerHandle`'s own doc
  // comment) reassigns this after startup, and every closure below that
  // reads `ruleEngine` does so lazily (inside a request/CONNECT handler, not
  // at this line) — reassigning it here is enough for a subsequent request
  // to see the new engine, with no further wiring per call site.
  let ruleEngine = options.ruleEngine;
  // Issue #147, macOS-only (see `ClientProcessDirectory`'s own doc comment
  // for why this polls in the background rather than looking up per
  // request) — `undefined` everywhere else, so `buildBaseExchange`'s lookup
  // is skipped entirely rather than starting a directory that could never
  // find anything.
  // Not `.start()`ed yet — only once `proxy.listen` below actually succeeds,
  // so a startup that aborts (port in use, `proxy.listen` throwing) never
  // leaves its background polling running with no proxy for it to serve.
  const clientProcessDirectory = isClientProcessLookupSupported()
    ? new ClientProcessDirectory(nodeCommandRunner)
    : undefined;
  // Keyed by ctx.uuid so the request-phase and response-phase handlers
  // (which fire as separate callbacks) can agree on the same exchange.
  const inFlight = new Map<string, CapturedExchange>();
  // Keyed by ctx.uuid so the response-phase handlers know which rule (if
  // any) matched this request — matching itself only happens once, in
  // onRequest, since it's the same for both. Only ever holds the *terminal*
  // rule (mock/route/breakpoint/script) — a matching `rewrite` rule never
  // becomes terminal, so it lives in `rewriteContexts` below instead.
  const ruleContexts = new Map<string, Rule>();
  // Keyed by ctx.uuid: every matching `rewrite` rule for this request (see
  // `MatchedRules`'s doc comment), applied cumulatively at both the request
  // and response phase — unlike `ruleContexts`, there can be more than one.
  const rewriteContexts = new Map<string, Rule[]>();
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

  // Getters, not the values themselves: `ruleEngine`/`throttleState` are
  // both mutable above (a Rule Profile switch, a dashboard Throttle toggle),
  // and this handler is constructed once at startup — a plain snapshot
  // parameter would freeze it to whatever was true at that moment instead
  // of tracking runtime changes.
  const handleInterceptOffConnect = createInterceptOffConnectHandler({
    eventBus,
    getRuleEngine: () => ruleEngine,
    getThrottleState: () => throttleState,
  });

  proxy.onConnect(
    createConnectHandler({
      eventBus,
      getBlockHostsState: () => blockHostsState,
      getFocusHosts: () => focusHosts,
      getInterceptEnabled: () => interceptEnabled,
      handleInterceptOffConnect,
    }),
  );

  const webSocketHandlers = createWebSocketHandlers({ eventBus, wsConnections });
  proxy.onWebSocketConnection(webSocketHandlers.onConnection);
  proxy.onWebSocketFrame(webSocketHandlers.onFrame);
  proxy.onWebSocketClose(webSocketHandlers.onClose);
  proxy.onWebSocketError(webSocketHandlers.onError);

  proxy.onError(
    createProxyErrorHandler({
      eventBus,
      breakpoints,
      inFlight,
      ruleContexts,
      rewriteContexts,
      scriptModules,
      scriptRequestBodies,
    }),
  );

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
  const handleRequestBreakpoint = createRequestBreakpointHandler({
    eventBus,
    breakpoints,
    inFlight,
    ruleContexts,
    rewriteContexts,
  });
  const handleScriptRequestHook = createScriptRequestHookHandler({ eventBus, scriptRequestBodies });
  const handleResponseBreakpoint = createResponseBreakpointHandler({
    eventBus,
    breakpoints,
    inFlight,
    ruleContexts,
    rewriteContexts,
  });
  const handleScriptResponseHook = createScriptResponseHookHandler({
    eventBus,
    inFlight,
    ruleContexts,
    rewriteContexts,
    scriptRequestBodies,
  });

  // Response header/status rewrites must run before ProxyEngine flushes
  // them to the client — see applyResponseHeaderRewrite's doc comment.
  proxy.onResponseHeaders(
    createResponseHeadersHandler({
      inFlight,
      ruleContexts,
      rewriteContexts,
      scriptModules,
      handleResponseBreakpoint,
      handleScriptResponseHook,
    }),
  );

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
        const exchange = buildBaseExchange(
          ctx,
          { url, method, host: reqHost, ruleName: `block-hosts (${blockHostsState.mode})` },
          clientProcessDirectory,
        );
        inFlight.set(ctx.uuid, exchange);
        // A blocked request never forwards to upstream (callback() is never
        // called below), so the usual onRequestData/onRequestEnd hooks never
        // run for it — capture the client's raw request stream directly
        // instead, same as the `mock` branch below.
        const requestCapture = captureClientRequestBody(ctx, exchange);
        const respondBlocked = () => {
          requestCapture.applyTo(exchange, 'request');
          const outcome = resolveBlockedRequestOutcome(blockHostsState.mode, reqHost);
          if (outcome.kind === 'reset') {
            sendMockSimulate(ctx, 'close');
            eventBus.emit('request', exchange);
            exchange.error = outcome.errorMessage;
            exchange.finishedAt = Date.now();
            exchange.durationMs = exchange.finishedAt - exchange.startedAt;
            eventBus.emit('response', exchange);
            inFlight.delete(ctx.uuid);
            return;
          }
          const { mock } = outcome;
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
      const { rewrites, terminal } = resolveExchangeAction(ruleEngine, {
        method,
        url,
        host: reqHost,
        interceptEnabled,
        focusHosts,
      });

      // Every matching `rewrite` rule applies (see `MatchedRules`'s doc
      // comment), so more than one can show up here — joined, rather than
      // just the last one, so the dashboard's badge/tooltip (`RuleBadge`)
      // doesn't silently hide that a second rule also matched.
      const ruleName = [...rewrites, ...(terminal ? [terminal] : [])].map((r) => r.name).join(', ') || undefined;
      const exchange = buildBaseExchange(ctx, { url, method, host: reqHost, ruleName }, clientProcessDirectory);
      inFlight.set(ctx.uuid, exchange);

      // Apply every matching `rewrite` rule's request path/query/header
      // changes now, before dispatching to any terminal rule below — so a
      // `mock`'s dashboard snapshot, a `breakpoint`'s live-edit payload, and
      // a `script` rule's `beforeRequest` all see the already-rewritten
      // request too (Copilot review, PR #150), consistent with "every
      // matching rewrite rule applies up to the first terminal rule" — the
      // `ruleName` badge above already joins every one of their names
      // together regardless of what `terminal` turns out to be, so their
      // effects need to actually be visible everywhere that badge shows up.
      // Body rewriting is the one exception: buffering and rewriting the
      // whole body twice would double-write it to the socket (see
      // `applyRequestRewrite`'s `installRequestBodyRewrite`, which writes
      // directly to the upstream request once the client's body ends rather
      // than through the onRequestData chain a second rewrite could
      // observe) — so only the *last* matching rule with a `request.body`
      // actually replaces it, while path/query/headers fully stack. (For a
      // `mock` specifically, none of this ever reaches the wire either way —
      // it never forwards upstream — but the dashboard should still show
      // what the request would have looked like if it had.)
      for (const r of rewrites) {
        if (r.action.type !== 'rewrite' || !r.action.request) continue;
        applyRequestRewrite(ctx, { ...r.action.request, body: undefined });
      }
      const requestBodyRewriteRule = selectLastMatchingBodyRewriteRule(rewrites, 'request');
      if (requestBodyRewriteRule && requestBodyRewriteRule.action.type === 'rewrite') {
        applyRequestRewrite(ctx, { body: requestBodyRewriteRule.action.request!.body });
      }
      if (rewrites.some((r) => r.action.type === 'rewrite' && r.action.request)) {
        rewriteContexts.set(ctx.uuid, rewrites);
        // Re-sync the dashboard-visible snapshot from what was actually
        // just mutated — same pattern `handleBreakpointResume`'s own
        // path/header edits already follow. Without this, `exchange.url`/
        // `requestHeaders` stayed the client's original request forever:
        // `buildBaseExchange` captures them once, before this rewrite runs,
        // from `ctx.clientToProxyRequest` — a separate object from
        // `ctx.proxyToServerRequestOptions`, which is what the rewrite (and
        // this line) actually mutates.
        const opts = ctx.proxyToServerRequestOptions;
        if (opts) {
          exchange.url = `${ctx.isSSL ? 'https' : 'http'}://${exchange.host}${opts.path}`;
          exchange.requestHeaders = { ...opts.headers };
        }
      } else if (rewrites.some((r) => r.action.type === 'rewrite' && r.action.response)) {
        // No request-side changes, but a matching rule still has a
        // response-side rewrite to apply once the response arrives.
        rewriteContexts.set(ctx.uuid, rewrites);
      }

      if (terminal?.action.type === 'mock') {
        const mockAction = terminal.action;
        const simulate = mockAction.simulate;
        let mockError: string | undefined;
        const mock = simulate
          ? undefined
          : tryResolveMock(terminal, ruleEngine!.basePath, ruleEngine!.allowExternalScriptPaths, (message) => {
              mockError = message;
            });

        // A mock's response never passes through onResponseHeaders/onResponse
        // (it's synthesized here, not streamed from upstream), so a matching
        // rewrite rule's `response` changes need applying directly to it —
        // otherwise `ruleName`'s joined badge would imply they took effect
        // when they silently hadn't (Copilot review, PR #150 — see
        // `applyResponseRewritesToMock`'s own doc comment).
        if (mock) applyResponseRewritesToMock(mock, rewrites);

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
              exchange.error = `rule "${terminal.name}": simulated connection close (no response sent)`;
              exchange.finishedAt = Date.now();
              exchange.durationMs = exchange.finishedAt - exchange.startedAt;
              eventBus.emit('response', exchange);
            }
            // 'timeout' deliberately never emits 'response': the exchange
            // stays "pending" in the dashboard for as long as the connection
            // stays open, same as a real server that stopped responding.
            inFlight.delete(ctx.uuid);
            rewriteContexts.delete(ctx.uuid);
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
          rewriteContexts.delete(ctx.uuid);
        };
        if (mockError) {
          eventBus.emit('error', {
            id: ctx.uuid,
            errorKind: 'RULE_MOCK_ERROR',
            message: `rule "${terminal.name}": ${mockError}`,
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

      if (terminal?.action.type === 'breakpoint' && terminal.action.request !== false) {
        ruleContexts.set(ctx.uuid, terminal);
        handleRequestBreakpoint(ctx, terminal, exchange, callback);
        return;
      }

      if (terminal?.action.type === 'script') {
        ruleContexts.set(ctx.uuid, terminal);
        const module = tryLoadScriptModule(
          terminal,
          ruleEngine!.basePath,
          ruleEngine!.allowExternalScriptPaths,
          (message) => eventBus.emit('error', { id: ctx.uuid, errorKind: 'RULE_SCRIPT_ERROR', message }),
        );
        // Always runs (not just when `beforeRequest` is defined) — a
        // `beforeResponse` hook (checked separately at the response phase)
        // needs the real, full request body as its `req` argument, which
        // only this path captures; see `scriptRequestBodies`' doc comment.
        if (module) {
          handleScriptRequestHook(ctx, { rule: terminal, module }, exchange, callback);
          return;
        }
        // The module failed to load — forward unchanged; `onResponse`/
        // `onResponseHeaders` below independently try loading it again for
        // `beforeResponse` (see `tryLoadScriptModule`'s mtime-based cache —
        // this is cheap, and lets a fixed script recover without a restart).
      }

      if (terminal) ruleContexts.set(ctx.uuid, terminal);
      if (terminal?.action.type === 'route') {
        applyRouteAction(ctx, terminal.action);
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
        !requestBodyRewriteRule;
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

  proxy.onResponse(
    createResponseHandler({
      eventBus,
      getRuleEngine: () => ruleEngine,
      getThrottleState: () => throttleState,
      inFlight,
      ruleContexts,
      rewriteContexts,
      scriptModules,
      scriptRequestBodies,
    }),
  );

  return new Promise((resolve, reject) => {
    try {
      proxy.listen(
        {
          port: options.port,
          host,
          sslCaDir,
          http2: options.http2Enabled ?? true,
          upstreamProxyUrl: options.upstreamProxyUrl,
        },
        () => {
          clientProcessDirectory?.start();
          resolve({
            port: proxy.httpPort,
            caCertPath: proxy.ca.getCACertPath(),
            setRuleEngine: (engine) => {
              ruleEngine = engine;
            },
            stop: () =>
              new Promise<void>((res) => {
                eventBus.off('breakpointResume', handleBreakpointResume);
                eventBus.off('setIntercept', handleSetIntercept);
                eventBus.off('setFocus', handleSetFocus);
                eventBus.off('setThrottle', handleSetThrottle);
                eventBus.off('setBlockHosts', handleSetBlockHosts);
                clientProcessDirectory?.stop();
                ruleEngine?.close();
                proxy.close();
                res();
              }),
          });
        },
      );
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
