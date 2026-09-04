/**
 * Types (and pure merge logic) for a `script` rule action (issue #9): a
 * user-authored Node.js module providing `beforeRequest`/`beforeResponse`
 * hooks for request/response transformation that the declarative `rewrite`
 * action can't express — the hooks run real JS, so they can inspect/
 * transform a body, branch on arbitrary conditions, call other services,
 * etc.
 *
 * Loading the module off disk and invoking a hook against a live exchange
 * is Infrastructure's job (see infra/fs/scriptModuleLoader.ts and
 * infra/proxy/proxyServer.ts's `handleScriptRequestHook`/
 * `handleScriptResponseHook`) — this file only describes the shapes a hook
 * sees/returns, and the pure "apply a hook's partial result onto the
 * current req/res" merge shared by both call sites.
 */

export interface ScriptRequestInfo {
  method: string;
  /** Fully-qualified URL, e.g. `https://api.example.com/users/1?x=2`. Read-only — a script can't redirect the request (use a `route` rule for that). */
  url: string;
  /**
   * A request never legitimately carries a multi-value header (Node/
   * ProxyEngine already fold request headers down to plain strings by
   * the time they reach here — the well-known multi-value case, `Set-Cookie`,
   * is response-only), so this is always plain strings, unlike
   * `ScriptResponseInfo.headers`.
   */
  headers: Record<string, string>;
  /**
   * The full, untruncated request body — unlike `CapturedExchange`'s own
   * `requestBody` (shown in the dashboard), this is never capped at
   * `MAX_CAPTURED_BODY_BYTES`, since a hook that appends to/transforms it
   * must never silently corrupt a large upload.
   */
  body: Buffer;
}

/**
 * Partial changes a `beforeRequest` hook returns. Any omitted field is left
 * unchanged; returning `undefined`/`null` (or nothing at all) leaves the
 * request untouched entirely.
 */
export interface ScriptRequestResult {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

export interface ScriptResponseInfo {
  status: number;
  statusMessage?: string;
  /**
   * A multi-value header (most notably `Set-Cookie`, which legitimately
   * repeats) is kept as a `string[]` rather than comma-joined — joining it
   * would produce a value no client can correctly split back apart (a
   * cookie's own `Expires` attribute routinely contains a comma). Set a
   * `string[]` for such a header if a hook needs to add/replace one.
   */
  headers: Record<string, string | string[]>;
  /**
   * The full, untruncated response body — unlike `CapturedExchange`'s own
   * `responseBody` (shown in the dashboard), this is never capped at
   * `MAX_CAPTURED_BODY_BYTES`, since a hook that appends to/transforms it
   * must never silently corrupt what's actually sent to the client.
   */
  body: Buffer;
}

/** Partial changes a `beforeResponse` hook returns. Same "omitted = unchanged" rule as `ScriptRequestResult`. */
export interface ScriptResponseResult {
  status?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
  body?: Buffer | string;
}

/**
 * The shape a `script` rule's module must `module.exports`. Both hooks are
 * optional (a module needs only the one it cares about) and may be `async`
 * — awaited by the caller either way.
 */
export interface ScriptModule {
  beforeRequest?: (
    req: ScriptRequestInfo,
  ) => ScriptRequestResult | null | undefined | void | Promise<ScriptRequestResult | null | undefined | void>;
  beforeResponse?: (
    req: ScriptRequestInfo,
    res: ScriptResponseInfo,
  ) => ScriptResponseResult | null | undefined | void | Promise<ScriptResponseResult | null | undefined | void>;
}

function resolveBody(body: Buffer | string | undefined, fallback: Buffer): Buffer {
  if (body === undefined) return fallback;
  return Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
}

/**
 * Merges a `beforeRequest` hook's partial result onto the request that was
 * passed to it. Pure — the hook itself already ran by the time this is
 * called; this just decides the final method/headers/body.
 */
export function applyScriptRequestResult(
  base: ScriptRequestInfo,
  result: ScriptRequestResult | null | undefined,
): ScriptRequestInfo {
  if (!result) return base;
  return {
    method: (result.method ?? base.method).toUpperCase(),
    url: base.url,
    headers: result.headers ?? base.headers,
    body: resolveBody(result.body, base.body),
  };
}

/**
 * Merges a `beforeResponse` hook's partial result onto the response that
 * was passed to it. Pure, mirroring `applyScriptRequestResult`.
 */
export function applyScriptResponseResult(
  base: ScriptResponseInfo,
  result: ScriptResponseResult | null | undefined,
): ScriptResponseInfo {
  if (!result) return base;
  return {
    status: result.status ?? base.status,
    statusMessage: result.statusMessage ?? base.statusMessage,
    headers: result.headers ?? base.headers,
    body: resolveBody(result.body, base.body),
  };
}
