import { Proxy } from 'http-mitm-proxy';
import type { IContext } from 'http-mitm-proxy';
import { resolveCertDir } from './certStore';
import type { DetourEventBus } from './eventBus';
import { assertPortAvailable } from './portCheck';
import type { CapturedExchange } from './types';

export interface ProxyServerOptions {
  port: number;
  host?: string;
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
  // Keyed by ctx.uuid so the request-phase and response-phase handlers
  // (which fire as separate callbacks) can agree on the same exchange.
  const inFlight = new Map<string, CapturedExchange>();

  proxy.onError((ctx, err, errorKind) => {
    eventBus.emit('error', {
      id: ctx?.uuid,
      errorKind: errorKind ?? 'UNKNOWN',
      message: err?.message ?? 'unknown proxy error',
    });
  });

  proxy.onRequest((ctx, callback) => {
    const { url, host: reqHost } = resolveUrl(ctx);
    const exchange: CapturedExchange = {
      id: ctx.uuid,
      method: ctx.clientToProxyRequest.method ?? 'GET',
      url,
      host: reqHost,
      isSSL: ctx.isSSL,
      requestHeaders: { ...ctx.clientToProxyRequest.headers },
      requestBodySize: 0,
      responseBodySize: 0,
      startedAt: Date.now(),
    };
    inFlight.set(ctx.uuid, exchange);

    ctx.onRequestData((_dataCtx, chunk, cb) => {
      exchange.requestBodySize += chunk.length;
      return cb(undefined, chunk);
    });

    ctx.onRequestEnd((_endCtx, cb) => {
      // Published as soon as the request is fully sent, before the
      // response arrives — lets consumers (e.g. a future dashboard)
      // show a request as "pending" while it's in flight.
      eventBus.emit('request', exchange);
      return cb();
    });

    return callback();
  });

  proxy.onResponse((ctx, callback) => {
    const exchange = inFlight.get(ctx.uuid);
    if (exchange && ctx.serverToProxyResponse) {
      exchange.statusCode = ctx.serverToProxyResponse.statusCode;
      exchange.statusMessage = ctx.serverToProxyResponse.statusMessage;
      exchange.responseHeaders = { ...ctx.serverToProxyResponse.headers };
    }

    ctx.onResponseData((_dataCtx, chunk, cb) => {
      if (exchange) exchange.responseBodySize += chunk.length;
      return cb(undefined, chunk);
    });

    ctx.onResponseEnd((_endCtx, cb) => {
      if (exchange) {
        exchange.finishedAt = Date.now();
        exchange.durationMs = exchange.finishedAt - exchange.startedAt;
        eventBus.emit('response', exchange);
        inFlight.delete(ctx.uuid);
      }
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
