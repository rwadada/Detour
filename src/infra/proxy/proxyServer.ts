import type { ProxyAuthCredentials } from '../../domain/auth/proxyAuth';
import { normalizeBlockHosts } from '../../domain/blockHosts/blockHostsPolicy';
import { ExchangeRegistry } from '../../domain/exchange/exchangeRegistry';
import type {
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
  /**
   * `--script-timeout-ms` (issue #161): how long a `script` rule's
   * `beforeRequest`/`beforeResponse` hook may run before its exchange is
   * forwarded untouched and the timeout is logged as an error — see
   * `usecase/runScriptHooks.ts`'s `withTimeout`. Defaults to
   * `DEFAULT_SCRIPT_TIMEOUT_MS`.
   */
  scriptTimeoutMs?: number;
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
  const runtimeState = new ProxyRuntimeState({ ruleEngine: options.ruleEngine });

  // Issue #147, macOS-only (see `ClientProcessDirectory`'s own doc comment)
  const clientProcessDirectory = isClientProcessLookupSupported()
    ? new ClientProcessDirectory(nodeCommandRunner)
    : undefined;

  // Single registry managing per-exchange state (Flow equivalent) — issue #208.
  const exchangeRegistry = new ExchangeRegistry();

  // Keyed by ctx.uuid for WebSocket connections.
  const wsConnections = new Map<string, CapturedWebSocketConnection>();

  const handleSetIntercept = (enabled: boolean): void => {
    runtimeState.update({ interceptEnabled: enabled });
    eventBus.emit('interceptChanged', { enabled });
  };
  eventBus.on('setIntercept', handleSetIntercept);

  const handleSetFocus = (hosts: string[]): void => {
    const focusHosts = normalizeFocusHosts(hosts);
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
  });

  proxy.onConnect(
    createConnectHandler({
      eventBus,
      runtimeState,
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
            stop: () =>
              new Promise<void>((res) => {
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
