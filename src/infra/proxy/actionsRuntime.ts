import path from 'node:path';
import type { IContext } from 'http-mitm-proxy';
import { applyBodyRewrite } from '../../domain/rules/bodyRewrite';
import { applyHeaderRewrite } from '../../domain/rules/headerRewrite';
import { type MockResponse } from '../../domain/rules/mockResponse';
import { applyQueryRewrite } from '../../domain/rules/queryRewrite';
import { computeRouteTarget } from '../../domain/rules/routeAction';
import type { ScriptModule } from '../../domain/rules/scriptAction';
import type { BodyRewrite, MockAction, RewriteAction, RouteAction, ScriptAction } from '../../domain/rules/types';
import { resolveMockAction } from '../../usecase/resolveMockAction';
import { fsMockBodyFileReader } from '../fs/mockBodyFileReader';
import { fsScriptModuleLoader } from '../fs/scriptModuleLoader';

export type { MockResponse };

/** Resolves a `mock` action's `body`/`bodyFile` into bytes, reading `bodyFile` (if set) off disk via `fsMockBodyFileReader` — see `resolveMockAction`/`buildMockResponse` for the actual assembly logic. */
export function resolveMockResponse(action: MockAction, basePath: string): MockResponse {
  return resolveMockAction(action, basePath, fsMockBodyFileReader);
}

/**
 * Responds to the client directly, without ever contacting the upstream
 * server. Callers must not call the `onRequest` callback afterwards — per
 * http-mitm-proxy's own convention (see its `preventRequest` example),
 * leaving it uncalled is what stops the request from being forwarded.
 */
export function sendMockResponse(ctx: IContext, mock: MockResponse): void {
  // Drain (and discard) any request body still in flight so the client
  // socket isn't left waiting on us before it can be reused.
  ctx.clientToProxyRequest.resume();
  if (mock.statusMessage !== undefined) {
    ctx.proxyToClientResponse.writeHead(mock.status, mock.statusMessage, mock.headers);
  } else {
    ctx.proxyToClientResponse.writeHead(mock.status, mock.headers);
  }
  ctx.proxyToClientResponse.end(mock.body);
}

/**
 * Ends a mocked exchange without ever sending a response, per a `mock`
 * action's `simulate`. `'close'` destroys the client socket immediately,
 * so the client sees a connection reset; `'timeout'` deliberately does
 * nothing, leaving the connection open so the client hangs until it hits
 * its own read timeout. Same calling convention as `sendMockResponse`:
 * callers must not call the `onRequest` callback afterwards.
 */
export function sendMockSimulate(ctx: IContext, simulate: 'timeout' | 'close'): void {
  // Drain (and discard) any request body still in flight, same as sendMockResponse.
  ctx.clientToProxyRequest.resume();
  if (simulate === 'close') {
    ctx.proxyToClientResponse.destroy();
  }
  // 'timeout': no-op — the connection is intentionally left hanging.
}

/** Resolves a `script` action's `path` (relative to rules.json) and loads the module — see `fsScriptModuleLoader` for the loading/caching mechanics. */
export function loadScriptModule(action: ScriptAction, basePath: string): ScriptModule {
  return fsScriptModuleLoader.load(path.resolve(basePath, action.path));
}

/** Redirects the outbound connection to a different host/port than the one the client addressed — see `computeRouteTarget` for the underlying decision. */
export function applyRouteAction(ctx: IContext, action: RouteAction): void {
  const opts = ctx.proxyToServerRequestOptions;
  if (!opts) return;
  const target = computeRouteTarget(action, { port: opts.port, isSSL: ctx.isSSL });
  opts.host = target.host;
  if (target.port !== undefined) opts.port = target.port;
  if (target.hostHeader !== undefined) opts.headers['host'] = target.hostHeader;
}

/**
 * Buffers the whole outgoing request body, rewrites it, and writes the
 * result once the client has finished sending. The caller is responsible
 * for dropping the upstream Content-Length header beforehand, since the
 * rewritten body's length isn't known until the original has fully arrived.
 */
function installRequestBodyRewrite(ctx: IContext, rewrite: BodyRewrite): void {
  const chunks: Buffer[] = [];
  ctx.onRequestData((_dataCtx, chunk, cb) => {
    chunks.push(chunk);
    return cb(undefined, Buffer.alloc(0));
  });
  ctx.onRequestEnd((_endCtx, cb) => {
    const rewritten = applyBodyRewrite(Buffer.concat(chunks), rewrite);
    if (rewritten.length > 0) ctx.proxyToServerRequest?.write(rewritten);
    return cb();
  });
}

/**
 * Buffers the whole incoming response body, rewrites it, and writes the
 * result to the client once the upstream response has finished.
 * `onFinalSize` reports the byte count actually sent, for logging.
 */
export function installResponseBodyRewrite(
  ctx: IContext,
  rewrite: BodyRewrite,
  onFinalSize?: (size: number) => void,
): void {
  const chunks: Buffer[] = [];
  ctx.onResponseData((_dataCtx, chunk, cb) => {
    chunks.push(chunk);
    return cb(undefined, Buffer.alloc(0));
  });
  ctx.onResponseEnd((_endCtx, cb) => {
    const rewritten = applyBodyRewrite(Buffer.concat(chunks), rewrite);
    onFinalSize?.(rewritten.length);
    if (rewritten.length > 0) ctx.proxyToClientResponse.write(rewritten);
    return cb();
  });
}

/** Applies a rewrite rule's query-string/header changes, and sets up body rewriting if requested. */
export function applyRequestRewrite(ctx: IContext, rewrite: NonNullable<RewriteAction['request']>): void {
  const opts = ctx.proxyToServerRequestOptions;
  if (!opts) return;
  applyQueryRewrite(opts, rewrite.query);
  applyHeaderRewrite(opts.headers, rewrite.headers);
  if (rewrite.body) {
    // The rewritten body's length is unknown up front; send chunked instead.
    delete opts.headers['content-length'];
    installRequestBodyRewrite(ctx, rewrite.body);
  }
}

/**
 * Applies a rewrite rule's response status/header changes. Must run from
 * the proxy-level `onResponseHeaders` hook (see proxyServer.ts), before
 * headers are flushed to the client — http-mitm-proxy only invokes
 * per-context `onResponseHeaders` registrations for request headers, not
 * response ones, so this can't be wired through `ctx.onResponseHeaders`.
 */
export function applyResponseHeaderRewrite(ctx: IContext, rewrite: NonNullable<RewriteAction['response']>): void {
  const res = ctx.serverToProxyResponse;
  if (!res) return;
  if (rewrite.status !== undefined) res.statusCode = rewrite.status;
  applyHeaderRewrite(res.headers, rewrite.headers);
}
