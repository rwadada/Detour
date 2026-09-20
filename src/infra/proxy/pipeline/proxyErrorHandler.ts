import { describeUpstreamTlsError } from '../../../domain/exchange/tlsVerificationError';
import type { CapturedExchange } from '../../../domain/exchange/types';
import type { ScriptModule } from '../../../domain/rules/scriptAction';
import type { Rule } from '../../../domain/rules/types';
import type { BreakpointCoordinator } from '../../../usecase/breakpointCoordinator';
import type { DetourEventBus } from '../../eventBus';
import { attachCertificate, attachTiming, attachUpstreamProtocol } from '../attachTiming';
import type { OnErrorParams } from '../engine/types';

export interface ProxyErrorHandlerDeps {
  eventBus: DetourEventBus;
  breakpoints: BreakpointCoordinator;
  /** Keyed by ctx.uuid — shared with the rest of the pipeline, not owned here. */
  inFlight: Map<string, CapturedExchange>;
  ruleContexts: Map<string, Rule>;
  rewriteContexts: Map<string, Rule[]>;
  scriptModules: Map<string, ScriptModule>;
  scriptRequestBodies: Map<string, Buffer>;
}

/**
 * ProxyEngine's catch-all for a proxy-level failure (a `route` rule's
 * destination refusing the connection, a DNS failure, a TLS handshake
 * error, etc.) — see issue #109: without this, an exchange whose upstream
 * connection failed stayed stuck "pending" in the dashboard forever, with
 * no indication anything went wrong.
 */
export function createProxyErrorHandler(deps: ProxyErrorHandlerDeps): OnErrorParams {
  const { eventBus, breakpoints, inFlight, ruleContexts, rewriteContexts, scriptModules, scriptRequestBodies } = deps;

  return function handleProxyError(ctx, err, errorKind) {
    if (ctx) {
      // Finalize the exchange this error belongs to before dropping it from
      // `inFlight` — otherwise the dashboard never learns the request
      // failed and shows it "pending" forever. Guarded on `finishedAt`
      // being unset so a late/unrelated error after the exchange already
      // completed normally (e.g. a response-stream error after `response`
      // was already emitted) doesn't overwrite it.
      const exchange = inFlight.get(ctx.uuid);
      if (exchange && exchange.finishedAt === undefined) {
        // A TLS certificate-verification failure (issue #160) gets a
        // specific, actionable message instead of the generic one below —
        // `describeUpstreamTlsError` recognizes it by `err.code` regardless
        // of which `errorKind` reported it, since only the proxy→upstream
        // leg can ever produce one of these codes in the first place.
        const tlsMessage = describeUpstreamTlsError(err);
        exchange.error = tlsMessage ?? `${errorKind ?? 'UNKNOWN'}: ${err?.message ?? 'unknown proxy error'}`;
        exchange.finishedAt = Date.now();
        exchange.durationMs = exchange.finishedAt - exchange.startedAt;
        attachTiming(exchange, ctx);
        attachCertificate(exchange, ctx);
        attachUpstreamProtocol(exchange, ctx);
        eventBus.emit('response', exchange);
      }
      inFlight.delete(ctx.uuid);
      ruleContexts.delete(ctx.uuid);
      rewriteContexts.delete(ctx.uuid);
      scriptModules.delete(ctx.uuid);
      scriptRequestBodies.delete(ctx.uuid);
      breakpoints.resolve({ id: ctx.uuid, phase: 'request', action: 'abort' });
      breakpoints.resolve({ id: ctx.uuid, phase: 'response', action: 'abort' });
    }
    eventBus.emit('error', {
      id: ctx?.uuid,
      errorKind: errorKind ?? 'UNKNOWN',
      message: err?.message ?? 'unknown proxy error',
    });
  };
}
