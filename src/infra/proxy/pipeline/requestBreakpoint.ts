import { BodyCapture } from '../../../domain/exchange/bodyCapture';
import { flattenHeaders } from '../../../domain/exchange/headers';
import type { BreakpointRequestPayload, CapturedExchange } from '../../../domain/exchange/types';
import type { Rule } from '../../../domain/rules/types';
import type { BreakpointCoordinator } from '../../../usecase/breakpointCoordinator';
import type { DetourEventBus } from '../../eventBus';
import type { ErrorCallback, IContext } from '../engine/types';

export interface RequestBreakpointDeps {
  eventBus: DetourEventBus;
  breakpoints: BreakpointCoordinator;
  /** Keyed by ctx.uuid — shared with the rest of the pipeline, not owned here. */
  inFlight: Map<string, CapturedExchange>;
  ruleContexts: Map<string, Rule>;
  rewriteContexts: Map<string, Rule[]>;
}

/**
 * Pauses a request-phase `breakpoint` rule for interactive inspection/
 * editing from the dashboard, then either aborts it (502 to the client) or
 * resumes it — with any edits applied — to continue toward upstream.
 */
export function createRequestBreakpointHandler(deps: RequestBreakpointDeps) {
  const { eventBus, breakpoints, inFlight, ruleContexts, rewriteContexts } = deps;

  return function handleRequestBreakpoint(
    ctx: IContext,
    rule: Rule,
    exchange: CapturedExchange,
    callback: ErrorCallback,
  ): void {
    // `chunks` is the real (uncapped) body that gets forwarded upstream once
    // resumed; `displayCapture` is a separate, capped copy purely for the
    // dashboard's `exchange.requestBody`. A single capped `BodyCapture` used
    // for both (as this used to do) would truncate the body actually sent to
    // the server at MAX_CAPTURED_BODY_BYTES for a request the user resumed
    // without editing — see issue #95.
    const displayCapture = new BodyCapture();
    const chunks: Buffer[] = [];
    ctx.clientToProxyRequest.on('data', (chunk: Buffer) => {
      exchange.requestBodySize += chunk.length;
      displayCapture.add(chunk);
      chunks.push(chunk);
    });
    // See captureClientRequestBody's doc comment (proxyServer.ts): without
    // resuming the (pre-paused) stream here, it never emits 'data'/'end' at all.
    ctx.clientToProxyRequest.resume();

    const pause = () => {
      displayCapture.applyTo(exchange, 'request');
      const rawBody = Buffer.concat(chunks);
      // `chunks` (via the still-registered 'data' listener's closure) and
      // `rawBody` would otherwise both hold the full body in memory at
      // once — for a large upload paused at a breakpoint, that's an
      // avoidable doubling of peak memory. The individual chunk Buffers can
      // be GC'd once `rawBody` (its single-buffer copy) exists.
      chunks.length = 0;

      const opts = ctx.proxyToServerRequestOptions;
      const payload: BreakpointRequestPayload = {
        phase: 'request',
        id: ctx.uuid,
        method: exchange.method,
        path: opts?.path ?? ctx.clientToProxyRequest.url ?? '/',
        headers: flattenHeaders(opts?.headers ?? ctx.clientToProxyRequest.headers),
        body: exchange.requestBody,
        // Read directly off `displayCapture` rather than the exchange field
        // it just set — a re-wrap of an already-capped buffer later (see the
        // `BodyCapture.of(finalBody)` below) must never be mistaken for this.
        bodyTruncated: displayCapture.isTruncated,
      };
      eventBus.emit('breakpointHit', { exchange: { ...exchange, breakpoint: 'request' }, payload });

      breakpoints.wait(ctx.uuid, 'request').then((command) => {
        if (command.action === 'abort') {
          inFlight.delete(ctx.uuid);
          ruleContexts.delete(ctx.uuid);
          rewriteContexts.delete(ctx.uuid);
          exchange.error = `rule "${rule.name}": request aborted via breakpoint`;
          exchange.finishedAt = Date.now();
          exchange.durationMs = exchange.finishedAt - exchange.startedAt;
          eventBus.emit('response', exchange);
          ctx.proxyToClientResponse.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          ctx.proxyToClientResponse.end(`detour: request aborted via breakpoint rule "${rule.name}"`);
          // Deliberately never calls `callback`: leaving it uncalled is how
          // ProxyEngine is designed to skip forwarding to upstream.
          return;
        }

        const edits = command.edits;
        const finalBody = edits?.body !== undefined ? Buffer.from(edits.body, 'base64') : rawBody;

        if (opts) {
          if (edits?.method) opts.method = edits.method.toUpperCase();
          if (edits?.path) opts.path = edits.path;
          if (edits?.headers) opts.headers = { ...edits.headers };
          // The edited body's length may differ from the original; drop
          // content-length so Node sends it chunked instead (same as
          // installRequestBodyRewrite's callers do).
          delete opts.headers['content-length'];
          exchange.method = opts.method;
          exchange.url = `${ctx.isSSL ? 'https' : 'http'}://${exchange.host}${opts.path}`;
        }
        if (edits?.headers) exchange.requestHeaders = edits.headers;
        exchange.requestBodySize = finalBody.length;
        BodyCapture.of(finalBody).applyTo(exchange, 'request');

        ctx.onRequestData((_dataCtx, _chunk, cb) => cb(undefined, Buffer.alloc(0)));
        ctx.onRequestEnd((_endCtx, cb) => {
          if (finalBody.length > 0) ctx.proxyToServerRequest?.write(finalBody);
          eventBus.emit('request', exchange);
          return cb();
        });

        callback();
      });
    };

    if (ctx.clientToProxyRequest.complete) pause();
    else ctx.clientToProxyRequest.once('end', pause);
  };
}
