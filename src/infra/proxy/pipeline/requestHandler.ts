import type { IncomingHttpHeaders } from 'node:http';
import { PROXY_AUTHORIZATION_HEADER } from '../../../domain/auth/proxyAuth';
import { REDACTED } from '../../../domain/dump/dumpPolicy';
import { BodyCapture } from '../../../domain/exchange/bodyCapture';
import type { ExchangeRegistry } from '../../../domain/exchange/exchangeRegistry';
import type { CapturedExchange } from '../../../domain/exchange/types';
import { BandwidthState, transferDelayMs } from '../../../domain/throttle/bandwidth';
import { applyResponseRewritesToMock } from '../../../usecase/applyResponseRewritesToMock';
import { decideRequestAction } from '../../../usecase/decideRequestAction';
import type { ProxyRuntimeState } from '../../../usecase/proxyRuntimeState';
import { resolveBlockedRequestOutcome } from '../../../usecase/resolveBlockedRequestOutcome';
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
 */
function captureRequestHeaders(headers: Readonly<IncomingHttpHeaders>): IncomingHttpHeaders {
  const captured = { ...headers };
  if (captured[PROXY_AUTHORIZATION_HEADER] !== undefined) captured[PROXY_AUTHORIZATION_HEADER] = REDACTED;
  return captured;
}

/** Builds the initial `CapturedExchange` for a request just as it starts, before its outcome (blocked/mock/route/rewrite/forwarded) is known. */
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
    protocol: ctx.clientToProxyRequest.httpVersionMajor === 2 ? 'HTTP/2' : 'HTTP/1.1',
    requestHeaders: captureRequestHeaders(ctx.clientToProxyRequest.headers),
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: Date.now(),
    ruleName: info.ruleName,
  };
  if (clientProcessDirectory) {
    const { remoteAddress, remotePort } = ctx.clientToProxyRequest.socket;
    if (remoteAddress !== undefined && remotePort !== undefined) {
      const clientProcess = clientProcessDirectory.lookup(remoteAddress, remotePort);
      if (clientProcess) exchange.clientProcess = clientProcess;
    }
  }
  return exchange;
}

export interface RequestHandlerDeps {
  eventBus: DetourEventBus;
  runtimeState: ProxyRuntimeState;
  clientProcessDirectory: ClientProcessDirectory | undefined;
  exchangeRegistry: ExchangeRegistry;
  handleRequestBreakpoint: ReturnType<typeof createRequestBreakpointHandler>;
  handleScriptRequestHook: ReturnType<typeof createScriptRequestHookHandler>;
}

/**
 * The request-phase entry point: evaluates incoming requests via `decideRequestAction`,
 * executes the decided outcome (block, mock, pause, script, route, or forward), and
 * manages per-exchange context lifecycle in `ExchangeRegistry` (issue #208).
 */
// eslint-disable-next-line max-lines-per-function -- request pipeline stage factory; tracked under issue #208 (issue #207)
export function createRequestHandler(deps: RequestHandlerDeps): OnRequestParams {
  const {
    eventBus,
    runtimeState,
    clientProcessDirectory,
    exchangeRegistry,
    handleRequestBreakpoint,
    handleScriptRequestHook,
  } = deps;

  // eslint-disable-next-line max-lines-per-function -- request pipeline stage; tracked under issue #208 (issue #207)
  return function handleRequest(ctx: IContext, callback: ErrorCallback): void {
    // eslint-disable-next-line max-lines-per-function, sonarjs/cognitive-complexity -- request execution flow; tracked under issue #208 (issue #207)
    const run = () => {
      const { url, host: reqHost } = resolveUrl(ctx);
      const method = ctx.clientToProxyRequest.method ?? 'GET';
      const snapshot = runtimeState.getSnapshot();
      const action = decideRequestAction(snapshot, { method, url, host: reqHost });

      if (action.kind === 'block') {
        const exchange = buildBaseExchange(
          ctx,
          { url, method, host: reqHost, ruleName: action.ruleName },
          clientProcessDirectory,
        );
        exchangeRegistry.create(ctx.uuid, exchange);
        const requestCapture = captureClientRequestBody(ctx, exchange);
        const respondBlocked = () => {
          requestCapture.applyTo(exchange, 'request');
          const outcome = resolveBlockedRequestOutcome(action.mode, reqHost);
          if (outcome.kind === 'reset') {
            sendMockSimulate(ctx, 'close');
            eventBus.emit('request', exchange);
            exchange.error = outcome.errorMessage;
            exchange.finishedAt = Date.now();
            exchange.durationMs = exchange.finishedAt - exchange.startedAt;
            eventBus.emit('response', exchange);
            exchangeRegistry.finalize(ctx.uuid);
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
          exchangeRegistry.finalize(ctx.uuid);
        };
        if (ctx.clientToProxyRequest.complete) {
          respondBlocked();
        } else {
          ctx.clientToProxyRequest.once('end', respondBlocked);
        }
        return;
      }

      const exchange = buildBaseExchange(
        ctx,
        { url, method, host: reqHost, ruleName: action.ruleName },
        clientProcessDirectory,
      );
      const context = exchangeRegistry.create(ctx.uuid, exchange);
      context.terminalRule = action.terminal;
      context.rewriteRules = [...action.rewrites];

      for (const r of action.rewrites) {
        if (r.action.type !== 'rewrite' || !r.action.request) continue;
        applyRequestRewrite(ctx, { ...r.action.request, body: undefined });
      }
      const requestBodyRewriteRule = selectLastMatchingBodyRewriteRule(action.rewrites, 'request');
      if (requestBodyRewriteRule && requestBodyRewriteRule.action.type === 'rewrite') {
        applyRequestRewrite(ctx, { body: requestBodyRewriteRule.action.request!.body });
      }
      if (action.rewrites.some((r) => r.action.type === 'rewrite' && r.action.request)) {
        const opts = ctx.proxyToServerRequestOptions;
        if (opts) {
          exchange.url = `${ctx.isSSL ? 'https' : 'http'}://${exchange.host}${opts.path}`;
          exchange.requestHeaders = { ...opts.headers };
        }
      }

      if (action.kind === 'mock') {
        const ruleEngine = snapshot.ruleEngine;
        const mockAction = ruleEngine!.resolveMockStep(action.terminal);
        const simulate = mockAction.simulate;
        let mockError: string | undefined;
        const mock = simulate
          ? undefined
          : tryResolveMock(
              { ...action.terminal, action: mockAction },
              ruleEngine!.basePath,
              ruleEngine!.allowExternalScriptPaths,
              (message) => {
                mockError = message;
              },
            );

        if (mock) applyResponseRewritesToMock(mock, action.rewrites);

        const requestCapture = captureClientRequestBody(ctx, exchange);

        const respond = () => {
          requestCapture.applyTo(exchange, 'request');

          if (simulate) {
            sendMockSimulate(ctx, simulate);
            eventBus.emit('request', exchange);
            if (simulate === 'close') {
              exchange.error = `rule "${action.terminal.name}": simulated connection close (no response sent)`;
              exchange.finishedAt = Date.now();
              exchange.durationMs = exchange.finishedAt - exchange.startedAt;
              eventBus.emit('response', exchange);
            }
            exchangeRegistry.finalize(ctx.uuid);
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
          exchangeRegistry.finalize(ctx.uuid);
        };
        if (mockError) {
          eventBus.emit('error', {
            id: ctx.uuid,
            errorKind: 'RULE_MOCK_ERROR',
            message: `rule "${action.terminal.name}": ${mockError}`,
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
        if (ctx.clientToProxyRequest.complete) {
          sendMockAfterDelay();
        } else {
          ctx.clientToProxyRequest.once('end', sendMockAfterDelay);
        }
        return;
      }

      if (action.kind === 'pause') {
        handleRequestBreakpoint(ctx, action.terminal, exchange, callback);
        return;
      }

      if (action.kind === 'script') {
        const ruleEngine = snapshot.ruleEngine;
        const module = tryLoadScriptModule(action.terminal, {
          basePath: ruleEngine!.basePath,
          allowExternalPaths: ruleEngine!.allowExternalScriptPaths,
          allowScripts: ruleEngine!.allowScripts,
          onError: (message) => eventBus.emit('error', { id: ctx.uuid, errorKind: 'RULE_SCRIPT_ERROR', message }),
        });
        if (module) {
          context.scriptModule = module;
          handleScriptRequestHook(ctx, { rule: action.terminal, module }, exchange, callback);
          return;
        }
      }

      if (action.kind === 'route') {
        if (action.terminal.action.type === 'route') {
          applyRouteAction(ctx, action.terminal.action);
        }
      }

      const throttleState = snapshot.throttleState;
      const requestCapture = new BodyCapture();
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
        eventBus.emit('request', exchange);
        cb();
      });

      return callback();
    };

    const throttleState = runtimeState.getSnapshot().throttleState;
    const latency = throttleState.enabled ? throttleState.latencyMs : 0;
    if (latency > 0) setTimeout(run, latency);
    else run();
  };
}
