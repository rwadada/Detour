import fs from 'node:fs';
import path from 'node:path';
import type { IContext } from 'http-mitm-proxy';
import type { BodyRewrite, HeaderRewrite, MockAction, QueryRewrite, RewriteAction, RouteAction } from './types';

export interface MockResponse {
  status: number;
  statusMessage?: string;
  headers: Record<string, string>;
  body: Buffer;
}

function hasHeaderNamed(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

/** Resolves a `mock` action's `body`/`bodyFile` into bytes, filling in Content-Type/-Length if absent. */
export function resolveMockResponse(action: MockAction, basePath: string): MockResponse {
  let body: Buffer;
  let looksLikeJson = false;

  if (action.bodyFile !== undefined) {
    const filePath = path.resolve(basePath, action.bodyFile);
    body = fs.readFileSync(filePath);
    looksLikeJson = filePath.toLowerCase().endsWith('.json');
  } else if (action.body === undefined) {
    body = Buffer.alloc(0);
  } else if (typeof action.body === 'string') {
    body = Buffer.from(action.body, 'utf8');
  } else {
    body = Buffer.from(JSON.stringify(action.body), 'utf8');
    looksLikeJson = true;
  }

  const headers: Record<string, string> = { ...(action.headers ?? {}) };
  if (looksLikeJson && !hasHeaderNamed(headers, 'content-type')) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  if (!hasHeaderNamed(headers, 'content-length')) {
    headers['Content-Length'] = String(body.length);
  }

  return { status: action.status ?? 200, statusMessage: action.statusMessage, headers, body };
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

/** Redirects the outbound connection to a different host/port than the one the client addressed. */
export function applyRouteAction(ctx: IContext, action: RouteAction): void {
  const opts = ctx.proxyToServerRequestOptions;
  if (!opts) return;
  const originalPort = opts.port;
  opts.host = action.host;
  if (action.port !== undefined) opts.port = action.port;

  if (action.preserveHostHeader === false) {
    const defaultPort = ctx.isSSL ? 443 : 80;
    const port = action.port ?? originalPort;
    const portSuffix = port && Number(port) !== defaultPort ? `:${port}` : '';
    opts.headers['host'] = `${action.host}${portSuffix}`;
  }
}

function applyHeaderRewrite(headers: Record<string, string | string[] | undefined>, rewrite?: HeaderRewrite): void {
  if (!rewrite) return;
  for (const name of rewrite.remove ?? []) {
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
    }
  }
  for (const [name, value] of Object.entries(rewrite.set ?? {})) {
    headers[name] = value;
  }
}

/**
 * Rewrites a request's outgoing query string in place, on `opts.path`
 * (which http-mitm-proxy populates with the path *and* query together,
 * e.g. `/users/1?x=2`). `remove` runs before `set`, matching
 * `applyHeaderRewrite`'s ordering.
 */
function applyQueryRewrite(opts: { path?: string }, rewrite?: QueryRewrite): void {
  if (!rewrite) return;
  const path = opts.path ?? '/';
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : path.slice(queryIndex + 1));
  for (const name of rewrite.remove ?? []) {
    params.delete(name);
  }
  for (const [name, value] of Object.entries(rewrite.set ?? {})) {
    params.set(name, value);
  }
  const search = params.toString();
  opts.path = search ? `${pathname}?${search}` : pathname;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** JSON Merge Patch (RFC 7396): recursively applies `patch` onto `target`, `null` deleting a key. */
function jsonMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = jsonMergePatch(result[key], value);
    }
  }
  return result;
}

function applyBodyRewrite(original: Buffer, rewrite: BodyRewrite): Buffer {
  if (rewrite.set !== undefined) {
    return typeof rewrite.set === 'string'
      ? Buffer.from(rewrite.set, 'utf8')
      : Buffer.from(JSON.stringify(rewrite.set), 'utf8');
  }
  let text = original.toString('utf8');
  for (const step of rewrite.replace ?? []) {
    text = step.regex
      ? text.replace(new RegExp(step.find, step.flags ?? 'g'), step.replacement)
      : text.split(step.find).join(step.replacement);
  }
  if (rewrite.merge !== undefined) {
    // A body that isn't valid JSON (or is empty) merges onto an empty
    // object rather than throwing — see the `merge` doc comment on BodyRewrite.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    text = JSON.stringify(jsonMergePatch(parsed, rewrite.merge));
  }
  return Buffer.from(text, 'utf8');
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
 * the proxy-level `onResponseHeaders` hook, before headers are flushed to
 * the client (see proxyServer.ts — http-mitm-proxy only invokes
 * per-context `onResponseHeaders` registrations for request headers, not
 * response ones, so this can't be wired through `ctx.onResponseHeaders`).
 */
export function applyResponseHeaderRewrite(ctx: IContext, rewrite: NonNullable<RewriteAction['response']>): void {
  const res = ctx.serverToProxyResponse;
  if (!res) return;
  if (rewrite.status !== undefined) res.statusCode = rewrite.status;
  applyHeaderRewrite(res.headers, rewrite.headers);
}
