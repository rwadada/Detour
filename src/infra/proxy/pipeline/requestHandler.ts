import type { IncomingHttpHeaders } from 'node:http';
import { PROXY_AUTHORIZATION_HEADER } from '../../../domain/auth/proxyAuth';
import { isHostBlocked } from '../../../domain/blockHosts/blockHostsPolicy';
import { REDACTED } from '../../../domain/dump/dumpPolicy';
import { BodyCapture } from '../../../domain/exchange/bodyCapture';
import type { BlockHostsState, CapturedExchange, ThrottleState } from '../../../domain/exchange/types';
import type { Rule } from '../../../domain/rules/types';
import { BandwidthState, transferDelayMs } from '../../../domain/throttle/bandwidth';
import { applyResponseRewritesToMock } from '../../../usecase/applyResponseRewritesToMock';
import { resolveBlockedRequestOutcome } from '../../../usecase/resolveBlockedRequestOutcome';
import { resolveExchangeAction } from '../../../usecase/resolveExchangeAction';
import type { RuleEngine } from '../../../usecase/ruleEngine';
import { selectLastMatchingBodyRewriteRule } from '../../../usecase/selectBodyRewriteRule';
import type { DetourEventBus } from '../../eventBus';
import {
  applyRequestRewrite,
  applyRouteAction,
  sendMockResponse,
  sendMockSimulate,
  type MockResponse,
} from '../actionsRuntime';
import type { ClientProcessDirectory } from '../clientProcessLookup';
import type { ErrorCallback, IContext, OnRequestParams } from '../engine/types';
import { tryLoadScriptModule, tryResolveMock } from '../scriptModuleLoader';
import type { createRequestBreakpointHandler } from './requestBreakpoint';
import type { createScriptRequestHookHandler } from './scriptRequestHook';

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
 * Copies the client's request headers for capture, with
 * `Proxy-Authorization` replaced by `[REDACTED]` (issue #158).
 *
 * That header carries Detour's *own* `--proxy-auth` credentials, not the
 * origin's — it's never useful debugging output, and leaving it in would put
 * a base64'd username and password into the dashboard, into `--dump full`'s
 * console output and into every `--dump file` dump on disk. `dumpPolicy.ts`
 * redacts it at render time as well; doing it here too means the plaintext
 * never enters a `CapturedExchange` in the first place, so nothing that
 * reads one (the dashboard's WebSocket broadcast, `--persist`'s SQLite
 * history, a `script` rule) can see it either.
 */
function captureRequestHeaders(headers: Readonly<IncomingHttpHeaders>): IncomingHttpHeaders {
  const captured = { ...headers };
  // Node lowercases every header name it parses off the wire, so this
  // header only ever reaches here under its canonical lowercase key — no
  // case-insensitive lookup needed.
  if (captured[PROXY_AUTHORIZATION_HEADER] !== undefined) captured[PROXY_AUTHORIZATION_HEADER] = REDACTED;
  return captured;
}

/** Builds the initial `CapturedExchange` for a request just as it starts, before its outcome (blocked/mock/route/rewrite/forwarded) is known. Shared by the Block Hosts branch and the normal rule-resolution path below. */
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
    requestHeaders: captureRequestHeaders(ctx.clientToProxyRequest.headers),
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
 * Dependencies read live at call time, not captured once at construction:
 * `blockHostsState`/`interceptEnabled`/`focusHosts`/`ruleEngine`/
 * `throttleState` are all mutable in `startProxyServer`, so this takes
 * getters rather than snapshotted values.
 */
export interface RequestHandlerDeps {
  eventBus: DetourEventBus;
  getBlockHostsState: () => BlockHostsState;
  getInterceptEnabled: () => boolean;
  getFocusHosts: () => string[];
  getRuleEngine: () => RuleEngine | undefined;
  getThrottleState: () => ThrottleState;
  clientProcessDirectory: ClientProcessDirectory | undefined;
  /** Keyed by ctx.uuid — shared with the rest of the pipeline, not owned here. */
  inFlight: Map<string, CapturedExchange>;
  ruleContexts: Map<string, Rule>;
  rewriteContexts: Map<string, Rule[]>;
  handleRequestBreakpoint: ReturnType<typeof createRequestBreakpointHandler>;
  handleScriptRequestHook: ReturnType<typeof createScriptRequestHookHandler>;
}

/**
 * The request-phase entry point: denies a Block Hosts match, resolves the
 * rule engine's action for this exchange (mock/route/rewrite/breakpoint/
 * script/none), applies every matching `rewrite` rule's request-side
 * changes, then dispatches to whichever terminal action matched — or, if
 * none did, forwards the request upstream (behind Throttle's upload
 * simulation) like a plain passthrough proxy would.
 *
 * The entire handler runs behind Throttle's one-time per-exchange latency
 * delay (see `ThrottleState`'s doc comment), so every code path below
 * (including a `mock` rule's own response) shares the same simulated
 * round-trip cost.
 */
export function createRequestHandler(deps: RequestHandlerDeps): OnRequestParams {
  const {
    eventBus,
    getBlockHostsState,
    getInterceptEnabled,
    getFocusHosts,
    getRuleEngine,
    getThrottleState,
    clientProcessDirectory,
    inFlight,
    ruleContexts,
    rewriteContexts,
    handleRequestBreakpoint,
    handleScriptRequestHook,
  } = deps;

  return function handleRequest(ctx: IContext, callback: ErrorCallback): void {
    const run = () => {
      const { url, host: reqHost } = resolveUrl(ctx);
      const method = ctx.clientToProxyRequest.method ?? 'GET';
      const blockHostsState = getBlockHostsState();

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
      // `route` rule keeps applying (see `interceptEnabled`'s doc comment in
      // startProxyServer) — mock/rewrite/breakpoint rules are treated as if
      // nothing matched, so the request flows through untouched.
      const { rewrites, terminal } = resolveExchangeAction(getRuleEngine(), {
        method,
        url,
        host: reqHost,
        interceptEnabled: getInterceptEnabled(),
        focusHosts: getFocusHosts(),
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
        const ruleEngine = getRuleEngine();
        // Resolves `responses` (issue #181's sequential mock responses),
        // if the rule declares any — the 1st match gets `responses[0]`,
        // the 2nd `responses[1]`, and so on, per-rule and per-`RuleEngine`
        // (see its own doc comment). A plain rule with no `responses` gets
        // `terminal.action` back unchanged.
        const mockAction = ruleEngine!.resolveMockStep(terminal);
        const simulate = mockAction.simulate;
        let mockError: string | undefined;
        const mock = simulate
          ? undefined
          : tryResolveMock(
              { ...terminal, action: mockAction },
              ruleEngine!.basePath,
              ruleEngine!.allowExternalScriptPaths,
              (message) => {
                mockError = message;
              },
            );

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
        const ruleEngine = getRuleEngine();
        const module = tryLoadScriptModule(terminal, {
          basePath: ruleEngine!.basePath,
          allowExternalPaths: ruleEngine!.allowExternalScriptPaths,
          allowScripts: ruleEngine!.allowScripts,
          onError: (message) => eventBus.emit('error', { id: ctx.uuid, errorKind: 'RULE_SCRIPT_ERROR', message }),
        });
        // Always runs (not just when `beforeRequest` is defined) — a
        // `beforeResponse` hook (checked separately at the response phase)
        // needs the real, full request body as its `req` argument, which
        // only this path captures; see `scriptRequestBodies`' doc comment.
        if (module) {
          handleScriptRequestHook(ctx, { rule: terminal, module }, exchange, callback);
          return;
        }
        // The module failed to load — forward unchanged; `onResponse`/
        // `onResponseHeaders` independently try loading it again for
        // `beforeResponse` (see `tryLoadScriptModule`'s mtime-based cache —
        // this is cheap, and lets a fixed script recover without a restart).
      }

      if (terminal) ruleContexts.set(ctx.uuid, terminal);
      if (terminal?.action.type === 'route') {
        applyRouteAction(ctx, terminal.action);
      }

      const throttleState = getThrottleState();
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

    const throttleState = getThrottleState();
    const latency = throttleState.enabled ? throttleState.latencyMs : 0;
    if (latency > 0) setTimeout(run, latency);
    else run();
  };
}
