import type { ProxyAuthCredentials } from '../../domain/auth/proxyAuth';
import { normalizeBlockHosts } from '../../domain/blockHosts/blockHostsPolicy';
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
import { DEFAULT_THROTTLE_STATE, normalizeThrottleState } from '../../domain/throttle/throttlePolicy';
import { BreakpointCoordinator } from '../../usecase/breakpointCoordinator';
import type { RuleEngine } from '../../usecase/ruleEngine';
import { resolveCertDir } from '../certStore';
import type { DetourEventBus } from '../eventBus';
import { assertPortAvailable } from '../portCheck';
import { nodeCommandRunner } from '../process/nodeCommandRunner';
import { ClientProcessDirectory, isClientProcessLookupSupported } from './clientProcessLookup';
import { ProxyEngine } from './engine/proxyEngine';
import { createConnectHandler } from './pipeline/connectHandler';
import { createInterceptOffConnectHandler } from './pipeline/interceptOffConnect';
import { createProxyErrorHandler } from './pipeline/proxyErrorHandler';
import { createRequestBreakpointHandler } from './pipeline/requestBreakpoint';
import { createRequestHandler } from './pipeline/requestHandler';
import { createResponseBreakpointHandler } from './pipeline/responseBreakpoint';
import { createResponseHandler } from './pipeline/responseHandler';
import { createResponseHeadersHandler } from './pipeline/responseHeadersHandler';
import { createScriptRequestHookHandler } from './pipeline/scriptRequestHook';
import { createScriptResponseHookHandler } from './pipeline/scriptResponseHook';
import { createWebSocketHandlers } from './pipeline/webSocketHandlers';
import type { UpstreamTlsOptions } from './upstreamTlsOptions';

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
   * Whether the proxy→upstream leg attempts HTTP/2 at all (issue #166's
   * `--no-http2-upstream`) — independent of `http2Enabled` above, which
   * only ever governs the client-facing MITM'd side. `false` pins every
   * upstream request to HTTP/1.1, matching Detour's behavior before this
   * existed; also implicitly `false` once `upstreamProxyUrl` is set,
   * regardless of this option — see `UpstreamHttp2Pool`'s own doc comment.
   * @default true
   */
  http2UpstreamEnabled?: boolean;
  /**
   * Routes every proxy→upstream connection through this HTTP(S)/SOCKS proxy
   * instead of connecting to the real destination directly (issue #145) —
   * see `ProxyEngineOptions.upstreamProxyUrl`'s doc comment. Already
   * validated by the caller (`cli.ts`). Omit for direct connections.
   */
  upstreamProxyUrl?: string;
  /**
   * Requires every client to authenticate before the proxy will serve it
   * (issue #158's `--proxy-auth`) — see `ProxyEngineOptions.proxyAuth`'s doc
   * comment. Enforced by `ProxyEngine` itself, ahead of every handler wired
   * below, so Block Hosts, Focus and the rule engine only ever see traffic
   * from an authenticated client. Omit (the default) to accept every client.
   */
  proxyAuth?: ProxyAuthCredentials;
  /**
   * Upstream TLS verification/mTLS overrides (issue #160's `--upstream-ca`/
   * `--insecure-upstream`/`--client-cert`+`--client-key`) — see
   * `ProxyEngineOptions.upstreamTls`'s doc comment. Already read/validated
   * by the caller (`upstreamTlsOptions.ts`'s `resolveUpstreamTlsOptions`).
   * Omit for Node's own default verification behavior, with no client
   * certificate — what Detour did before this existed.
   */
  upstreamTls?: UpstreamTlsOptions;
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

  proxy.onRequest(
    createRequestHandler({
      eventBus,
      getBlockHostsState: () => blockHostsState,
      getInterceptEnabled: () => interceptEnabled,
      getFocusHosts: () => focusHosts,
      getRuleEngine: () => ruleEngine,
      getThrottleState: () => throttleState,
      clientProcessDirectory,
      inFlight,
      ruleContexts,
      rewriteContexts,
      handleRequestBreakpoint,
      handleScriptRequestHook,
    }),
  );

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
          http2Upstream: options.http2UpstreamEnabled ?? true,
          upstreamProxyUrl: options.upstreamProxyUrl,
          proxyAuth: options.proxyAuth,
          upstreamTls: options.upstreamTls,
        },
        (err) => {
          // `listen()` itself reports a failure (e.g. issue #164's expired-CA
          // refusal) through this same callback, not by throwing synchronously
          // — this used to ignore `err` and resolve unconditionally, which
          // then threw *inside* `listen()`'s own catch block (`proxy.ca` is
          // never assigned on this path) as an unhandled rejection on a
          // promise nothing awaits, leaving this function's own Promise
          // neither resolved nor rejected. `detour start` just hung instead
          // of ever printing the intended error message.
          if (err) {
            reject(err);
            return;
          }
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
