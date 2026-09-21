import { BodyCapture } from '../../../domain/exchange/bodyCapture';
import type { CapturedExchange, ThrottleState } from '../../../domain/exchange/types';
import type { ScriptModule } from '../../../domain/rules/scriptAction';
import type { Rule } from '../../../domain/rules/types';
import { BandwidthState, transferDelayMs } from '../../../domain/throttle/bandwidth';
import { selectLastMatchingBodyRewriteRule } from '../../../usecase/selectBodyRewriteRule';
import type { RuleEngine } from '../../../usecase/ruleEngine';
import type { DetourEventBus } from '../../eventBus';
import { installResponseBodyRewrite } from '../actionsRuntime';
import { attachCertificate, attachTiming, attachUpstreamProtocol } from '../attachTiming';
import type { OnRequestParams } from '../engine/types';
import { tryLoadScriptModule } from '../scriptModuleLoader';

/**
 * Dependencies read live at call time, not captured once at construction:
 * `ruleEngine`/`throttleState` are both mutable in `startProxyServer`, so
 * this takes getters rather than snapshotted values.
 */
export interface ResponseHandlerDeps {
  eventBus: DetourEventBus;
  getRuleEngine: () => RuleEngine | undefined;
  getThrottleState: () => ThrottleState;
  /** Keyed by ctx.uuid — shared with the rest of the pipeline, not owned here. */
  inFlight: Map<string, CapturedExchange>;
  ruleContexts: Map<string, Rule>;
  rewriteContexts: Map<string, Rule[]>;
  scriptModules: Map<string, ScriptModule>;
  scriptRequestBodies: Map<string, Buffer>;
}

/**
 * The normal (non-breakpoint, non-`beforeResponse`-script) response path:
 * captures the upstream response for the dashboard, applies at most one
 * matching `rewrite` rule's response body replacement, and finalizes the
 * exchange once it's fully streamed to the client. A `breakpoint` or
 * `script` rule with response-phase work is instead fully handled by
 * `handleResponseBreakpoint`/`handleScriptResponseHook` from the earlier
 * `onResponseHeaders` hook (which needs to run *before* headers are
 * flushed) — this handler just steps aside for those (`return callback()`)
 * so the same exchange isn't captured/finalized twice.
 */
export function createResponseHandler(deps: ResponseHandlerDeps): OnRequestParams {
  const {
    eventBus,
    getRuleEngine,
    getThrottleState,
    inFlight,
    ruleContexts,
    rewriteContexts,
    scriptModules,
    scriptRequestBodies,
  } = deps;

  return function handleResponse(ctx, callback) {
    const exchange = inFlight.get(ctx.uuid);
    const terminal = ruleContexts.get(ctx.uuid);

    // Unlike the header/status rewrites above (moved ahead of these two
    // branches in `onResponseHeaders`), a matching rule's `response.body`
    // rewrite deliberately does NOT thread into a breakpoint/script
    // response here (Copilot review, PR #150): both already consume the
    // raw upstream body themselves, via their own `res.on('data', ...)`
    // listener rather than the `onResponseData`/`onResponseEnd` hook chain
    // `installResponseBodyRewrite` (below) uses — installing that hook
    // chain *as well* would mean two independent consumers of the same
    // response stream, each capable of writing to the client, risking a
    // corrupted double-written response. A breakpoint's live-edit payload
    // and a `beforeResponse` hook's `res.body` argument both still see
    // upstream's real, unrewritten body.
    if (terminal?.action.type === 'breakpoint' && terminal.action.response !== false) {
      // Fully handled by handleResponseBreakpoint from the onResponseHeaders
      // hook instead, which needs to pause *before* headers are flushed —
      // skip the normal capture/bookkeeping below entirely so it isn't done
      // twice (once here with an empty body, once there with the real one).
      return callback();
    }

    const ruleEngine = getRuleEngine();
    if (terminal?.action.type === 'script') {
      // Load (or reuse the cached) module now to decide whether this rule
      // even has a `beforeResponse` hook — a rule with only `beforeRequest`
      // has nothing left to do at the response phase and falls through to
      // the normal capture/forwarding below, same as a `route`/no-op rule.
      const module = tryLoadScriptModule(
        terminal,
        ruleEngine!.basePath,
        ruleEngine!.allowExternalScriptPaths,
        (message) => eventBus.emit('error', { id: ctx.uuid, errorKind: 'RULE_SCRIPT_ERROR', message }),
      );
      if (module?.beforeResponse) {
        scriptModules.set(ctx.uuid, module);
        // Fully handled by handleScriptResponseHook from onResponseHeaders
        // instead (needs the response *before* headers are flushed — see
        // its doc comment), mirroring the breakpoint skip just above.
        return callback();
      }
      // No `beforeResponse` (or the module failed to load) — nothing will
      // consume the full request body `handleScriptRequestHook` stashed
      // for it (see `scriptRequestBodies`' doc comment); drop it here
      // rather than leak it until `onError`.
      scriptRequestBodies.delete(ctx.uuid);
    }

    if (exchange && ctx.serverToProxyResponse) {
      exchange.statusCode = ctx.serverToProxyResponse.statusCode;
      exchange.statusMessage = ctx.serverToProxyResponse.statusMessage;
      exchange.responseHeaders = { ...ctx.serverToProxyResponse.headers };
    }

    // Every matching `rewrite` rule's `response.body` would each want to
    // buffer and replace the whole body — like the request side, only the
    // *last* one actually does (see `selectLastMatchingBodyRewriteRule`'s
    // doc comment for why chaining more than one isn't safe).
    const responseBodyRewriteRule = selectLastMatchingBodyRewriteRule(rewriteContexts.get(ctx.uuid) ?? [], 'response');

    const throttleState = getThrottleState();
    const responseCapture = new BodyCapture();
    // Throttle's download bandwidth cap/packet-loss simulation, applied
    // per-chunk as it streams to the client — see the upload side's
    // identical comment in `proxy.onRequest`. Skipped when a `rewrite`
    // rule is also rewriting this body: its own onResponseData hook is
    // registered *after* this one (right below), so if this hook reduced
    // every chunk to empty first, the rewrite would see nothing to rewrite.
    const throttleDownload =
      throttleState.enabled &&
      (throttleState.downKbps > 0 || throttleState.packetLossPct > 0) &&
      !responseBodyRewriteRule;
    const downBandwidth = new BandwidthState();
    ctx.onResponseData((_dataCtx, chunk, cb) => {
      if (exchange) {
        exchange.responseBodySize += chunk.length;
        responseCapture.add(chunk);
      }
      if (!throttleDownload) return cb(undefined, chunk);
      const delay = transferDelayMs(chunk.length, throttleState.downKbps, throttleState.packetLossPct, downBandwidth);
      if (delay > 0) setTimeout(() => cb(undefined, chunk), delay);
      else cb(undefined, chunk);
    });

    if (responseBodyRewriteRule && responseBodyRewriteRule.action.type === 'rewrite') {
      installResponseBodyRewrite(ctx, responseBodyRewriteRule.action.response!.body!, (finalSize) => {
        if (exchange) exchange.responseBodySize = finalSize;
      });
    }

    ctx.onResponseEnd((_endCtx, cb) => {
      if (exchange) {
        // Reflect a status rewrite applied in the onResponseHeaders hook above.
        if (ctx.serverToProxyResponse) exchange.statusCode = ctx.serverToProxyResponse.statusCode;
        exchange.finishedAt = Date.now();
        exchange.durationMs = exchange.finishedAt - exchange.startedAt;
        attachTiming(exchange, ctx);
        attachCertificate(exchange, ctx);
        attachUpstreamProtocol(exchange, ctx);
        // Captures the pre-rewrite body (mirroring responseBodySize's
        // accounting above) — the dashboard shows what actually came from
        // upstream, not what a rewrite rule replaced it with.
        responseCapture.applyTo(exchange, 'response');
        eventBus.emit('response', exchange);
        inFlight.delete(ctx.uuid);
      }
      ruleContexts.delete(ctx.uuid);
      rewriteContexts.delete(ctx.uuid);
      cb();
    });

    return callback();
  };
}
