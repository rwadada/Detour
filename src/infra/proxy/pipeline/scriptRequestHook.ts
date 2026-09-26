import { BodyCapture } from '../../../domain/exchange/bodyCapture';
import { deleteHeader, flattenHeaders } from '../../../domain/exchange/headers';
import type { CapturedExchange } from '../../../domain/exchange/types';
import type { ScriptModule, ScriptRequestInfo } from '../../../domain/rules/scriptAction';
import type { Rule } from '../../../domain/rules/types';
import { DEFAULT_SCRIPT_TIMEOUT_MS, runBeforeRequest } from '../../../usecase/runScriptHooks';
import type { DetourEventBus } from '../../eventBus';
import type { ErrorCallback, IContext } from '../engine/types';

export interface ScriptRequestHookDeps {
  eventBus: DetourEventBus;
  /** Keyed by ctx.uuid — shared with the response phase, not owned here. */
  scriptRequestBodies: Map<string, Buffer>;
  /** `--script-timeout-ms` (issue #161) — see `runBeforeRequest`'s own doc comment. */
  scriptTimeoutMs?: number;
}

/**
 * Runs for every `script` rule at the request phase (issue #9), whether
 * or not its module actually defines `beforeRequest` — see the doc
 * comment on `scriptRequestBodies` for why: a `beforeResponse` hook must
 * always see the *real* request body, so the full body has to be
 * captured here unconditionally rather than only when there's a
 * transform to apply. Mirrors `handleRequestBreakpoint`'s shape (capture
 * the full body directly off `clientToProxyRequest`, then decide) rather
 * than the `rewrite` action's onRequestData/onRequestEnd streaming style:
 * a header/method change from the hook must land on
 * `proxyToServerRequestOptions` before the outer `callback` runs —
 * ProxyEngine creates the actual upstream request right after that (see
 * `makeProxyToServerRequest` in engine/proxyEngine.ts), so a change
 * applied any later would silently miss the request that already went
 * out. One consequence: unlike a plain forwarded request, a `script`
 * rule's (fully-buffered) upload never participates in Throttle's upload
 * simulation — the same trade-off `mock`/`breakpoint` already make.
 *
 * Deliberately does NOT reuse `captureClientRequestBody`/`BodyCapture` for
 * the body actually handed to the hook (and forwarded upstream): that
 * capture is capped at `MAX_CAPTURED_BODY_BYTES` for the dashboard's own
 * display copy, and per its doc comment the cap must never affect what's
 * actually proxied — silently truncating a large upload here would be
 * exactly that. `chunks` below is the real (uncapped) body; `displayCapture`
 * is a second, capped copy purely for `exchange.requestBody`.
 */
export function createScriptRequestHookHandler(deps: ScriptRequestHookDeps) {
  const { eventBus, scriptRequestBodies, scriptTimeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS } = deps;

  return function handleScriptRequestHook(
    ctx: IContext,
    matched: { rule: Rule; module: ScriptModule },
    exchange: CapturedExchange,
    callback: ErrorCallback,
  ): void {
    const { rule, module } = matched;
    const displayCapture = new BodyCapture();
    const chunks: Buffer[] = [];
    ctx.clientToProxyRequest.on('data', (chunk: Buffer) => {
      exchange.requestBodySize += chunk.length;
      displayCapture.add(chunk);
      chunks.push(chunk);
    });
    // See captureClientRequestBody's doc comment: without resuming the
    // (pre-paused) stream here, it never emits 'data'/'end' at all.
    ctx.clientToProxyRequest.resume();

    const forwardBody = (body: Buffer) => {
      // Handed to `beforeResponse` (if this rule also defines one) as its
      // `req.body` — see `scriptRequestBodies`' doc comment.
      scriptRequestBodies.set(ctx.uuid, body);
      ctx.onRequestData((_dataCtx, _chunk, cb) => cb(undefined, Buffer.alloc(0)));
      ctx.onRequestEnd((_endCtx, cb) => {
        if (body.length > 0) ctx.proxyToServerRequest?.write(body);
        eventBus.emit('request', exchange);
        return cb();
      });
      callback();
    };

    const run = () => {
      displayCapture.applyTo(exchange, 'request');
      const opts = ctx.proxyToServerRequestOptions;
      const body = Buffer.concat(chunks);
      if (!opts) {
        forwardBody(body);
        return;
      }

      const req: ScriptRequestInfo = {
        method: exchange.method,
        url: exchange.url,
        headers: flattenHeaders(opts.headers),
        body,
      };

      const applyResult = (result: ScriptRequestInfo) => {
        opts.method = result.method;
        opts.headers = { ...result.headers };
        // The (possibly rewritten) body's length is unknown up front — send
        // chunked instead, same as installRequestBodyRewrite. Case-
        // insensitive: a hook can spell it any way it likes, unlike headers
        // straight off the wire (always lowercased by Node).
        deleteHeader(opts.headers, 'content-length');
        exchange.method = result.method;
        // From `opts.headers` (post-delete), not `result.headers` — the
        // dashboard's own copy of what was sent must not show a
        // content-length that was actually stripped before forwarding.
        exchange.requestHeaders = opts.headers;
        exchange.requestBodySize = result.body.length;
        BodyCapture.of(result.body).applyTo(exchange, 'request');
        forwardBody(result.body);
      };

      runBeforeRequest(module, req, scriptTimeoutMs)
        .then(applyResult)
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          eventBus.emit('error', {
            id: ctx.uuid,
            errorKind: 'RULE_SCRIPT_ERROR',
            message: `rule "${rule.name}": beforeRequest failed: ${message}`,
          });
          forwardBody(body); // Forward the original, untouched request rather than drop it.
        });
    };

    if (ctx.clientToProxyRequest.complete) run();
    else ctx.clientToProxyRequest.once('end', run);
  };
}
