import { BodyCapture } from '../../../domain/exchange/bodyCapture';
import { compactHeaders, deleteHeader, flattenHeaders } from '../../../domain/exchange/headers';
import type { CapturedExchange } from '../../../domain/exchange/types';
import type { ScriptModule, ScriptRequestInfo, ScriptResponseInfo } from '../../../domain/rules/scriptAction';
import type { Rule } from '../../../domain/rules/types';
import { DEFAULT_SCRIPT_TIMEOUT_MS, runBeforeResponse } from '../../../usecase/runScriptHooks';
import type { DetourEventBus } from '../../eventBus';
import { attachCertificate, attachTiming, attachUpstreamProtocol } from '../attachTiming';
import type { ErrorCallback, IContext } from '../engine/types';

export interface ScriptResponseHookDeps {
  eventBus: DetourEventBus;
  /** Keyed by ctx.uuid — shared with the rest of the pipeline, not owned here. */
  inFlight: Map<string, CapturedExchange>;
  ruleContexts: Map<string, Rule>;
  rewriteContexts: Map<string, Rule[]>;
  /** Keyed by ctx.uuid — set by the request phase's script hook, read (and cleared) here. */
  scriptRequestBodies: Map<string, Buffer>;
  /** `--script-timeout-ms` (issue #161) — see `runBeforeResponse`'s own doc comment. */
  scriptTimeoutMs?: number;
}

/**
 * Runs a `script` rule's `beforeResponse` hook (issue #9), invoked from
 * `onResponseHeaders` — same reasoning as `applyResponseHeaderRewrite`/
 * `handleResponseBreakpoint`: status/headers can only still be edited
 * there, since ProxyEngine flushes them to the client the moment its
 * callback fires. Reads the upstream body directly off
 * `serverToProxyResponse` (mirroring `handleResponseBreakpoint`) so the
 * hook sees the full response before that callback is released; the
 * (possibly rewritten) body is then written from `onResponseEnd`, mirroring
 * `installResponseBodyRewrite`. `module` is passed in already-loaded (see
 * the `onResponse` handler below, which decided to route here in the
 * first place based on whether it defines `beforeResponse`).
 *
 * Deliberately accumulates the raw upstream body into a plain (uncapped)
 * `chunks` array rather than a capped `BodyCapture` — same reasoning as
 * `handleScriptRequestHook`: what's captured here is what's actually sent
 * back to the client, so it must never be silently truncated the way the
 * dashboard's own display copy is (see `finish`'s `BodyCapture.of` call,
 * which caps *that* copy on purpose).
 */
export function createScriptResponseHookHandler(deps: ScriptResponseHookDeps) {
  const {
    eventBus,
    inFlight,
    ruleContexts,
    rewriteContexts,
    scriptRequestBodies,
    scriptTimeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS,
  } = deps;

  return function handleScriptResponseHook(
    ctx: IContext,
    rule: Rule,
    module: ScriptModule,
    callback: ErrorCallback,
  ): void {
    const exchange = inFlight.get(ctx.uuid);
    const res = ctx.serverToProxyResponse;
    if (!res || !exchange) {
      callback();
      return;
    }

    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.resume();

    // Applies a (possibly hook-rewritten) response and releases `callback`,
    // flushing status/headers to the client. Shared by the success and
    // error paths below, mirroring `handleResponseBreakpoint`'s `resume`.
    const finish = (result: ScriptResponseInfo) => {
      res.statusCode = result.status;
      res.statusMessage = result.statusMessage;
      res.headers = { ...result.headers };
      // The final body's length may differ from upstream's — drop
      // content-length and let it go out chunked, same as elsewhere.
      // Case-insensitive: see the request-phase hook's identical fix.
      deleteHeader(res.headers, 'content-length');

      exchange.statusCode = result.status;
      exchange.statusMessage = result.statusMessage;
      // From `res.headers` (post-delete), not `result.headers` — same
      // reasoning as the request-phase hook's identical fix.
      exchange.responseHeaders = { ...res.headers };
      exchange.responseBodySize = result.body.length;
      BodyCapture.of(result.body).applyTo(exchange, 'response');
      exchange.finishedAt = Date.now();
      exchange.durationMs = exchange.finishedAt - exchange.startedAt;
      attachTiming(exchange, ctx);
      attachCertificate(exchange, ctx);
      attachUpstreamProtocol(exchange, ctx);

      ctx.onResponseData((_dataCtx, _chunk, cb) => cb(undefined, Buffer.alloc(0)));
      ctx.onResponseEnd((_endCtx, cb) => {
        if (result.body.length > 0) ctx.proxyToClientResponse.write(result.body);
        eventBus.emit('response', exchange);
        inFlight.delete(ctx.uuid);
        ruleContexts.delete(ctx.uuid);
        rewriteContexts.delete(ctx.uuid);
        return cb();
      });
      callback();
    };

    const run = () => {
      // The exact body `handleScriptRequestHook` forwarded upstream for
      // this same exchange — see `scriptRequestBodies`' doc comment. Falls
      // back to the dashboard's own (possibly truncated) display copy only
      // in the rare case that path never ran at all, e.g. the module
      // failed to load at the request phase but a fixed version loads
      // successfully by the time this (independent) response-phase load
      // runs — see the `onRequest` handler's script branch.
      const requestBody = scriptRequestBodies.get(ctx.uuid);
      scriptRequestBodies.delete(ctx.uuid);
      const reqInfo: ScriptRequestInfo = {
        method: exchange.method,
        url: exchange.url,
        headers: flattenHeaders(exchange.requestHeaders),
        body: requestBody ?? (exchange.requestBody ? Buffer.from(exchange.requestBody, 'base64') : Buffer.alloc(0)),
      };
      const resInfo: ScriptResponseInfo = {
        status: res.statusCode ?? 200,
        statusMessage: res.statusMessage,
        // Preserves a multi-value header (e.g. `set-cookie`) as an array —
        // see `compactHeaders`' doc comment for why `flattenHeaders`
        // (comma-joining) would corrupt it.
        headers: compactHeaders(res.headers),
        body: Buffer.concat(chunks),
      };

      runBeforeResponse(module, reqInfo, resInfo, scriptTimeoutMs)
        .then(finish)
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          eventBus.emit('error', {
            id: ctx.uuid,
            errorKind: 'RULE_SCRIPT_ERROR',
            message: `rule "${rule.name}": beforeResponse failed: ${message}`,
          });
          finish(resInfo); // Forward the original, untouched response rather than drop it.
        });
    };

    // `readableEnded`, not `.complete` (h2 upstream responses — issue #166
    // — have no such property at all; see `ProxyEngine.pumpChunks`'s own
    // doc comment for why this is the more precise check anyway).
    if (res.readableEnded) run();
    else res.once('end', run);
  };
}
