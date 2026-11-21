import type { ProxyAuthCredentials } from '../../domain/auth/proxyAuth';
import { createAutoPassthroughHosts, notifyingOnAdd } from '../../domain/autoPassthrough/clientCertRejection';
import { normalizeBlockHosts } from '../../domain/blockHosts/blockHostsPolicy';
import { ExchangeRegistry } from '../../domain/exchange/exchangeRegistry';
import type {
  AutoPassthroughState,
  BlockHostsState,
  BreakpointResumeCommand,
  CapturedWebSocketConnection,
  ThrottleState,
} from '../../domain/exchange/types';
import { normalizeFocusHosts } from '../../domain/focus/focusPolicy';
import { normalizeThrottleState } from '../../domain/throttle/throttlePolicy';
import { BreakpointCoordinator } from '../../usecase/breakpointCoordinator';
import { ProxyRuntimeState } from '../../usecase/proxyRuntimeState';
import type { RuleEngine } from '../../usecase/ruleEngine';
import { resolveCertDir } from '../certStore';
import type { DetourEventBus } from '../eventBus';
import { assertPortAvailable } from '../portCheck';
import { nodeCommandRunner } from '../process/nodeCommandRunner';
import { ClientProcessDirectory, isClientProcessLookupSupported } from './clientProcessLookup';
import { ProxyEngine } from './engine/proxyEngine';
import { createClientCertRejectionHandler } from './pipeline/clientCertRejection';
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

/** How many auto TLS passthrough records the dashboard is sent (soonest to lapse first); `total` says how many exist. */
const AUTO_PASSTHROUGH_ENTRIES_SHOWN = 100;
/** Records made within this window go out to the dashboard as one `autoPassthroughChanged`. */
const AUTO_PASSTHROUGH_ANNOUNCE_DELAY_MS = 250;

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
  /**
   * `--script-timeout-ms` (issue #161): how long a `script` rule's
   * `beforeRequest`/`beforeResponse` hook may run before its exchange is
   * forwarded untouched and the timeout is logged as an error — see
   * `usecase/runScriptHooks.ts`'s `withTimeout`. Defaults to
   * `DEFAULT_SCRIPT_TIMEOUT_MS`.
   */
  scriptTimeoutMs?: number;
  /**
   * Auto TLS passthrough (`--no-auto-passthrough` turns it off): once a
   * client refuses Detour's certificate for a host, relay later CONNECTs to
   * that host as raw TLS instead of MITM-ing them — see
   * `pipeline/clientCertRejection.ts`. A refusal is logged as a row either way.
   * @default true
   */
  autoPassthrough?: boolean;
  /**
   * Intercept's state at startup (issue #301, `--no-intercept`): off relays
   * every CONNECT untouched. The dashboard can still toggle it afterwards.
   * @default true
   */
  initialInterceptEnabled?: boolean;
  /**
   * Focus's host patterns at startup (issue #301, `--focus`): when non-empty,
   * only matching hosts are MITM'd. The dashboard can still change it.
   * @default []
   */
  initialFocusHosts?: readonly string[];
}

export interface ProxyServerHandle {
  /** Port the proxy actually bound to (relevant when options.port is 0). */
  port: number;
  /** Path to the auto-generated root CA, for the user to install/trust. */
  caCertPath: string;
  /**
   * Wires a `RuleEngine` into an already-running proxy that started without
   * one (`options.ruleEngine` was `undefined`) — every request/CONNECT
   * handler reads the engine through `ProxyRuntimeState` rather than
   * `options.ruleEngine` directly, so calling this makes already-matched
   * rule types (mock/route/rewrite/script) apply to traffic from this point
   * on, with no restart.
   */
  setRuleEngine(engine: RuleEngine): void;
  /**
   * Marks a port another listener in this process owns (the dashboard) as one
   * the proxy refuses to relay to (issue #205). The proxy listens on every
   * interface, so without this a LAN client could use it as a stepping stone
   * to the localhost-only dashboard. The proxy's own ports are protected
   * automatically.
   */
  protectLocalPort(port: number, address?: string): void;
  /** Whether `host:port` is one of this process's own listeners (the proxy, the dashboard, …) — see `ProxyEngine.isSelfTarget`. */
  isSelfTarget(host: string, port: number): Promise<boolean>;
  /** Auto TLS passthrough's current state (issue #302) — whether it is on, and the targets recorded right now. Changes are announced with `autoPassthroughChanged`. */
  autoPassthroughState(): AutoPassthroughState;
  stop(): Promise<void>;
}

/**
 * Starts the MITM proxy: intercepts HTTP and HTTPS (via on-the-fly
 * per-host leaf certs signed by our local CA) traffic and publishes a
 * `request`/`response` event for every exchange on the given event bus.
 */
// eslint-disable-next-line max-lines-per-function -- proxy server wiring + pipeline assembly; tracked under issue #208 (issue #207)
export async function startProxyServer(
  options: ProxyServerOptions,
  eventBus: DetourEventBus,
): Promise<ProxyServerHandle> {
  const host = options.host ?? 'localhost';
  await assertPortAvailable(options.port, host);

  const proxy = new ProxyEngine();
  const sslCaDir = resolveCertDir();

  // Centralized runtime state (Intercept, Focus, Throttle, Block Hosts, RuleEngine) — issue #208.
  const runtimeState = new ProxyRuntimeState({
    ruleEngine: options.ruleEngine,
    interceptEnabled: options.initialInterceptEnabled,
    focusHosts: normalizeFocusHosts(options.initialFocusHosts ?? []),
  });

  // Issue #147, macOS-only (see `ClientProcessDirectory`'s own doc comment)
  const clientProcessDirectory = isClientProcessLookupSupported()
    ? new ClientProcessDirectory(nodeCommandRunner)
    : undefined;

  // Single registry managing per-exchange state (Flow equivalent) — issue #208.
  const exchangeRegistry = new ExchangeRegistry();

  // Keyed by ctx.uuid for WebSocket connections.
  const wsConnections = new Map<string, CapturedWebSocketConnection>();

  // Auto TLS passthrough's record of refusing targets (see
  // `pipeline/clientCertRejection.ts`). Toggling Intercept or changing Focus
  // clears it — the user taking interception into their own hands is the
  // natural moment to MITM those hosts again, e.g. right after installing
  // the CA on a device that had refused it.
  const recordedRefusals = (options.autoPassthrough ?? true) ? createAutoPassthroughHosts() : undefined;
  // What the dashboard shows (issue #302). Each entry goes out with the time
  // it has left, which a client counts down from when it got it — no message
  // is needed when one lapses, and the two machines' clocks needn't agree.
  // Without `--proxy-auth` anything on the network can make refusals, so the
  // list sent is capped and additions are coalesced: otherwise a flood of
  // refusals would send every dashboard the whole (up to 10,000-entry) record
  // once per new entry.
  const autoPassthroughState = (): AutoPassthroughState => ({
    enabled: recordedRefusals !== undefined,
    entries: (recordedRefusals?.list(AUTO_PASSTHROUGH_ENTRIES_SHOWN) ?? []).map(
      ({ clientAddress, host, port, remainingMs }) => ({
        ...(clientAddress !== undefined ? { clientAddress } : {}),
        host,
        port,
        remainingMs: Math.round(remainingMs),
      }),
    ),
    total: recordedRefusals?.size() ?? 0,
  });
  // Two timers: one batching additions, one waiting for the first sent record
  // to lapse (see below). Kept apart so a pending lapse never holds back a
  // new addition.
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let lapseTimer: ReturnType<typeof setTimeout> | undefined;
  const clearAnnounceTimers = (): void => {
    clearTimeout(batchTimer);
    clearTimeout(lapseTimer);
    batchTimer = undefined;
    lapseTimer = undefined;
  };
  const announceAutoPassthroughNow = (): void => {
    clearAnnounceTimers();
    const state = autoPassthroughState();
    eventBus.emit('autoPassthroughChanged', state);
    // Records past the ones sent never lapse before them (oldest first), so
    // once the first sent one lapses, send again to bring the next ones in.
    const firstToLapse = state.entries[0];
    if (state.total > state.entries.length && firstToLapse) {
      lapseTimer = setTimeout(
        announceAutoPassthroughNow,
        Math.max(firstToLapse.remainingMs, AUTO_PASSTHROUGH_ANNOUNCE_DELAY_MS),
      );
      lapseTimer.unref();
    }
  };
  /** Coalesces additions: one announcement per `AUTO_PASSTHROUGH_ANNOUNCE_DELAY_MS` at most. */
  const announceAutoPassthrough = (): void => {
    if (batchTimer !== undefined) return;
    batchTimer = setTimeout(announceAutoPassthroughNow, AUTO_PASSTHROUGH_ANNOUNCE_DELAY_MS);
    batchTimer.unref();
  };
  // The same record, telling the dashboard about every target it newly takes in.
  const autoPassthroughHosts = recordedRefusals && notifyingOnAdd(recordedRefusals, announceAutoPassthrough);
  // Refusals logged without being recorded for passthrough; forgotten with it,
  // so a retry after the user acted (installed the CA, toggled Intercept)
  // shows up again instead of staying silent for the rest of the TTL.
  const loggedRefusals = createAutoPassthroughHosts();
  /** Announced at once, not coalesced: the user is looking at the list they just cleared. `'always'` answers an explicit request even when there was nothing to forget. */
  const forgetRefusals = (announce: 'if-changed' | 'always' = 'if-changed'): void => {
    const hadRecords = (recordedRefusals?.size() ?? 0) > 0;
    recordedRefusals?.clear();
    loggedRefusals.clear();
    if (hadRecords || announce === 'always') announceAutoPassthroughNow();
  };
  const handleForgetAutoPassthrough = (): void => forgetRefusals('always');
  eventBus.on('forgetAutoPassthrough', handleForgetAutoPassthrough);

  const handleSetIntercept = (enabled: boolean): void => {
    if (enabled !== runtimeState.getSnapshot().interceptEnabled) forgetRefusals();
    runtimeState.update({ interceptEnabled: enabled });
    eventBus.emit('interceptChanged', { enabled });
  };
  eventBus.on('setIntercept', handleSetIntercept);

  const handleSetFocus = (hosts: string[]): void => {
    const focusHosts = normalizeFocusHosts(hosts);
    const previous = runtimeState.getSnapshot().focusHosts;
    if (focusHosts.length !== previous.length || focusHosts.some((host, i) => host !== previous[i])) {
      forgetRefusals();
    }
    runtimeState.update({ focusHosts });
    eventBus.emit('focusChanged', { hosts: focusHosts });
  };
  eventBus.on('setFocus', handleSetFocus);

  const handleSetThrottle = (state: ThrottleState): void => {
    const throttleState = normalizeThrottleState(state);
    runtimeState.update({ throttleState });
    eventBus.emit('throttleChanged', throttleState);
  };
  eventBus.on('setThrottle', handleSetThrottle);

  const handleSetBlockHosts = (state: BlockHostsState): void => {
    const blockHostsState = { hosts: normalizeBlockHosts(state.hosts), mode: state.mode };
    runtimeState.update({ blockHostsState });
    eventBus.emit('blockHostsChanged', blockHostsState);
  };
  eventBus.on('setBlockHosts', handleSetBlockHosts);

  const breakpoints = new BreakpointCoordinator();
  const handleBreakpointResume = (command: BreakpointResumeCommand): void => breakpoints.resolve(command);
  eventBus.on('breakpointResume', handleBreakpointResume);

  const handleInterceptOffConnect = createInterceptOffConnectHandler({
    eventBus,
    runtimeState,
    guardedLookup: (port) => proxy.guardedLookup(port),
  });

  proxy.onTlsClientError(
    createClientCertRejectionHandler({ eventBus, runtimeState, autoPassthroughHosts, loggedRefusals }),
  );

  proxy.onConnect(
    createConnectHandler({
      eventBus,
      runtimeState,
      handleInterceptOffConnect,
      autoPassthroughHosts,
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
      exchangeRegistry,
    }),
  );

  const handleRequestBreakpoint = createRequestBreakpointHandler({
    eventBus,
    breakpoints,
    exchangeRegistry,
  });
  const handleScriptRequestHook = createScriptRequestHookHandler({
    eventBus,
    exchangeRegistry,
    scriptTimeoutMs: options.scriptTimeoutMs,
  });
  const handleResponseBreakpoint = createResponseBreakpointHandler({
    eventBus,
    breakpoints,
    exchangeRegistry,
  });
  const handleScriptResponseHook = createScriptResponseHookHandler({
    eventBus,
    exchangeRegistry,
    scriptTimeoutMs: options.scriptTimeoutMs,
  });

  proxy.onResponseHeaders(
    createResponseHeadersHandler({
      exchangeRegistry,
      handleResponseBreakpoint,
      handleScriptResponseHook,
    }),
  );

  proxy.onRequest(
    createRequestHandler({
      eventBus,
      runtimeState,
      clientProcessDirectory,
      exchangeRegistry,
      handleRequestBreakpoint,
      handleScriptRequestHook,
    }),
  );

  proxy.onResponse(
    createResponseHandler({
      eventBus,
      runtimeState,
      exchangeRegistry,
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
          if (err) {
            reject(err);
            return;
          }
          clientProcessDirectory?.start();
          resolve({
            port: proxy.httpPort,
            caCertPath: proxy.ca.getCACertPath(),
            setRuleEngine: (engine) => {
              runtimeState.update({ ruleEngine: engine });
            },
            protectLocalPort: (port, address) => proxy.protectLocalPort(port, address),
            isSelfTarget: (host, port) => proxy.isSelfTarget(host, port),
            autoPassthroughState,
            stop: () =>
              new Promise<void>((res) => {
                eventBus.off('forgetAutoPassthrough', handleForgetAutoPassthrough);
                clearAnnounceTimers();
                eventBus.off('breakpointResume', handleBreakpointResume);
                eventBus.off('setIntercept', handleSetIntercept);
                eventBus.off('setFocus', handleSetFocus);
                eventBus.off('setThrottle', handleSetThrottle);
                eventBus.off('setBlockHosts', handleSetBlockHosts);
                clientProcessDirectory?.stop();
                runtimeState.getSnapshot().ruleEngine?.close();
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
