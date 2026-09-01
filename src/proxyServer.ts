import { Proxy } from 'http-mitm-proxy';
import type { IContext } from 'http-mitm-proxy';
import { resolveCertDir } from './certStore';
import type { DetourEventBus } from './eventBus';
import { assertPortAvailable } from './portCheck';
import {
  applyRequestRewrite,
  applyResponseHeaderRewrite,
  applyRouteAction,
  installResponseBodyRewrite,
  resolveMockResponse,
  sendMockResponse,
  type MockResponse,
} from './rules/actions';
import type { RuleEngine } from './rules/ruleEngine';
import type { Rule } from './rules/types';
import type { CapturedExchange } from './types';

/**
 * Upper bound (in bytes, pre-base64) on how much of a request/response body
 * we hold in memory per exchange for the dashboard's inspector. Traffic
 * bodies can be arbitrarily large (file uploads/downloads); capturing them
 * unbounded would let a single exchange blow up process memory. Bytes past
 * this cap are still proxied through to the client/server as normal — only
 * the *captured copy* used for display is truncated.
 */
const MAX_CAPTURED_BODY_BYTES = 256 * 1024;

/** Accumulates chunks up to `MAX_CAPTURED_BODY_BYTES` and reports whether more arrived than that. */
class BodyCapture {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  private truncated = false;

  add(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.capturedBytes >= MAX_CAPTURED_BODY_BYTES) {
      this.truncated = true;
      return;
    }
    const room = MAX_CAPTURED_BODY_BYTES - this.capturedBytes;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(slice);
    this.capturedBytes += slice.length;
    if (slice.length < chunk.length) this.truncated = true;
  }

  /** Applies the capture to an exchange's `{prefix}Body`/`{prefix}BodyTruncated` fields. Omitted entirely when nothing was captured. */
  applyTo(exchange: CapturedExchange, prefix: 'request' | 'response'): void {
    if (this.chunks.length === 0) return;
    const body = Buffer.concat(this.chunks).toString('base64');
    if (prefix === 'request') {
      exchange.requestBody = body;
      exchange.requestBodyTruncated = this.truncated;
    } else {
      exchange.responseBody = body;
      exchange.responseBodyTruncated = this.truncated;
    }
  }

  /** Same capping as `add`, for a body that's already fully in memory (e.g. a resolved `mock` action's response). */
  static of(buffer: Buffer): BodyCapture {
    const capture = new BodyCapture();
    capture.add(buffer);
    return capture;
  }
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

  proxy.onError((ctx, err, errorKind) => {
    if (ctx) {
      inFlight.delete(ctx.uuid);
      ruleContexts.delete(ctx.uuid);
    }
    eventBus.emit('error', {
      id: ctx?.uuid,
      errorKind: errorKind ?? 'UNKNOWN',
      message: err?.message ?? 'unknown proxy error',
    });
  });

  // Response header/status rewrites must run before http-mitm-proxy
  // flushes them to the client. This has to be registered at the proxy
  // level (not via `ctx.onResponseHeaders`, which the library never
  // actually invokes) — see applyResponseHeaderRewrite's doc comment.
  proxy.onResponseHeaders((ctx, callback) => {
    const rule = ruleContexts.get(ctx.uuid);
    if (rule?.action.type === 'rewrite' && rule.action.response) {
      applyResponseHeaderRewrite(ctx, rule.action.response);
    }
    return callback();
  });

  proxy.onRequest((ctx, callback) => {
    const { url, host: reqHost } = resolveUrl(ctx);
    const method = ctx.clientToProxyRequest.method ?? 'GET';
    const rule = ruleEngine?.match({ method, url });

    const exchange: CapturedExchange = {
      id: ctx.uuid,
      method,
      url,
      host: reqHost,
      isSSL: ctx.isSSL,
      requestHeaders: { ...ctx.clientToProxyRequest.headers },
      requestBodySize: 0,
      responseBodySize: 0,
      startedAt: Date.now(),
      ruleName: rule?.name,
    };
    inFlight.set(ctx.uuid, exchange);

    if (rule?.action.type === 'mock') {
      const mockAction = rule.action;
      let mockError: string | undefined;
      const mock = tryResolveMock(rule, ruleEngine!.basePath, (message) => {
        mockError = message;
      });

      // A mock never forwards to upstream (callback() is never called
      // below), so the usual onRequestData/onRequestEnd hooks — which only
      // fire as part of that forwarding pipeline — never run for it. Capture
      // the client's raw request stream directly instead, so the dashboard
      // still shows what was actually sent to a mocked endpoint.
      const requestCapture = new BodyCapture();
      ctx.clientToProxyRequest.on('data', (chunk: Buffer) => {
        exchange.requestBodySize += chunk.length;
        requestCapture.add(chunk);
      });
      // http-mitm-proxy calls ctx.clientToProxyRequest.pause() before onRequest
      // runs; adding a 'data' listener alone does NOT auto-resume a stream
      // that was explicitly paused (see Readable.prototype.on in Node's
      // stream internals), so without this, the request stream never emits
      // 'data'/'end' and the wait below deadlocks forever.
      ctx.clientToProxyRequest.resume();

      const respond = () => {
        requestCapture.applyTo(exchange, 'request');
        sendMockResponse(ctx, mock);
        exchange.statusCode = mock.status;
        exchange.statusMessage = mock.statusMessage;
        exchange.responseHeaders = mock.headers;
        exchange.responseBodySize = mock.body.length;
        BodyCapture.of(mock.body).applyTo(exchange, 'response');
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

    if (rule) ruleContexts.set(ctx.uuid, rule);
    if (rule?.action.type === 'route') {
      applyRouteAction(ctx, rule.action);
    } else if (rule?.action.type === 'rewrite' && rule.action.request) {
      applyRequestRewrite(ctx, rule.action.request);
    }

    const requestCapture = new BodyCapture();
    ctx.onRequestData((_dataCtx, chunk, cb) => {
      exchange.requestBodySize += chunk.length;
      requestCapture.add(chunk);
      return cb(undefined, chunk);
    });

    ctx.onRequestEnd((_endCtx, cb) => {
      requestCapture.applyTo(exchange, 'request');
      // Published as soon as the request is fully sent, before the
      // response arrives — lets consumers (e.g. the dashboard) show a
      // request as "pending" while it's in flight.
      eventBus.emit('request', exchange);
      return cb();
    });

    return callback();
  });

  proxy.onResponse((ctx, callback) => {
    const exchange = inFlight.get(ctx.uuid);
    const rule = ruleContexts.get(ctx.uuid);
    if (exchange && ctx.serverToProxyResponse) {
      exchange.statusCode = ctx.serverToProxyResponse.statusCode;
      exchange.statusMessage = ctx.serverToProxyResponse.statusMessage;
      exchange.responseHeaders = { ...ctx.serverToProxyResponse.headers };
    }

    const responseCapture = new BodyCapture();
    ctx.onResponseData((_dataCtx, chunk, cb) => {
      if (exchange) {
        exchange.responseBodySize += chunk.length;
        responseCapture.add(chunk);
      }
      return cb(undefined, chunk);
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
      return cb();
    });

    return callback();
  });

  return new Promise((resolve, reject) => {
    try {
      proxy.listen({ port: options.port, host, sslCaDir }, () => {
        resolve({
          port: proxy.httpPort,
          caCertPath: proxy.ca.getCACertPath(),
          stop: () => new Promise<void>((res) => {
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
