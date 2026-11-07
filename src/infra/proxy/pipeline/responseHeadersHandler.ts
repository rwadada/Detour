import type { ExchangeRegistry } from '../../../domain/exchange/exchangeRegistry';
import { applyResponseHeaderRewrite } from '../actionsRuntime';
import type { OnRequestParams } from '../engine/types';
import type { createResponseBreakpointHandler } from './responseBreakpoint';
import type { createScriptResponseHookHandler } from './scriptResponseHook';

export interface ResponseHeadersHandlerDeps {
  exchangeRegistry: ExchangeRegistry;
  handleResponseBreakpoint: ReturnType<typeof createResponseBreakpointHandler>;
  handleScriptResponseHook: ReturnType<typeof createScriptResponseHookHandler>;
}

/**
 * Response header/status rewrites must run before ProxyEngine flushes them
 * to the client — see `applyResponseHeaderRewrite`'s doc comment — which is
 * also the only point a `breakpoint`/`script` rule's response-phase
 * handling can still edit status/headers before that flush, so both are
 * dispatched from here too.
 */
export function createResponseHeadersHandler(deps: ResponseHeadersHandlerDeps): OnRequestParams {
  const { exchangeRegistry, handleResponseBreakpoint, handleScriptResponseHook } = deps;

  return function handleResponseHeaders(ctx, callback) {
    const context = exchangeRegistry.get(ctx.uuid);
    const rule = context?.terminalRule;

    // Apply every matching `rewrite` rule's response status/header changes
    // first, before any terminal breakpoint/script handling below (Copilot
    // review, PR #150) — so a paused breakpoint's live-edit payload and a
    // `beforeResponse` hook's `res` argument both see the already-rewritten
    // status/headers too, consistent with "every matching rewrite rule
    // applies up to the first terminal rule." Safe to reorder: both
    // `handleResponseBreakpoint` and `handleScriptResponseHook` read
    // `ctx.serverToProxyResponse` by reference, the same object this
    // mutates directly, rather than a separately-captured snapshot.
    let appliedResponseHeaderRewrite = false;
    for (const r of context?.rewriteRules ?? []) {
      if (r.action.type !== 'rewrite' || !r.action.response) continue;
      applyResponseHeaderRewrite(ctx, r.action.response);
      appliedResponseHeaderRewrite = true;
    }
    if (appliedResponseHeaderRewrite) {
      // Re-sync the dashboard-visible snapshot from what was actually just
      // mutated — same pattern `handleResponseBreakpoint`/
      // `handleScriptResponseHook` already follow for their own edits.
      // Without this, `exchange.statusCode`/`responseHeaders` were captured
      // by the plain `onResponse` handler *before* this hook even runs (see
      // `ProxyEngine.onUpstreamResponse`: `onResponseHandlers` fires, then
      // `onResponseHeadersHandlers`), so a rewrite here was applied to the
      // real response the client received but silently never shown here.
      const exchange = context?.exchange;
      if (exchange && ctx.serverToProxyResponse) {
        exchange.statusCode = ctx.serverToProxyResponse.statusCode;
        exchange.statusMessage = ctx.serverToProxyResponse.statusMessage;
        exchange.responseHeaders = { ...ctx.serverToProxyResponse.headers };
      }
    }

    if (rule?.action.type === 'breakpoint' && rule.action.response !== false) {
      handleResponseBreakpoint(ctx, rule, callback);
      return;
    }
    if (rule?.action.type === 'script') {
      const module = context?.scriptModule;
      if (context) context.scriptModule = undefined;
      if (module) {
        handleScriptResponseHook(ctx, rule, module, callback);
        return;
      }
    }
    return callback();
  };
}
