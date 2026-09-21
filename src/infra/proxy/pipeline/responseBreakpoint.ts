import { BodyCapture } from '../../../domain/exchange/bodyCapture';
import { deleteHeader, flattenHeaders } from '../../../domain/exchange/headers';
import type { BreakpointResponsePayload, CapturedExchange } from '../../../domain/exchange/types';
import type { Rule } from '../../../domain/rules/types';
import type { BreakpointCoordinator } from '../../../usecase/breakpointCoordinator';
import type { DetourEventBus } from '../../eventBus';
import { attachCertificate, attachTiming, attachUpstreamProtocol } from '../attachTiming';
import type { ErrorCallback, IContext } from '../engine/types';

export interface ResponseBreakpointDeps {
  eventBus: DetourEventBus;
  breakpoints: BreakpointCoordinator;
  /** Keyed by ctx.uuid — shared with the rest of the pipeline, not owned here. */
  inFlight: Map<string, CapturedExchange>;
  ruleContexts: Map<string, Rule>;
  rewriteContexts: Map<string, Rule[]>;
}

/**
 * Pauses a response matched by a `breakpoint` rule (response phase) once
 * it's fully arrived from upstream but before any of it reaches the
 * client, and resumes/aborts it once the dashboard responds.
 *
 * Must run from the proxy-level `onResponseHeaders` hook (see
 * applyResponseHeaderRewrite's doc comment for why) — which is also the
 * only point status/headers can still be edited, since ProxyEngine
 * flushes them to the client immediately once this hook's callback fires.
 * Reads the upstream body directly off `serverToProxyResponse` (mirroring
 * handleRequestBreakpoint) so the full body is available before that
 * callback is released; once resumed, the (possibly edited) body is
 * written directly from `onResponseEnd` — mirroring
 * `installResponseBodyRewrite` — since the upstream stream was already
 * fully drained here.
 */
export function createResponseBreakpointHandler(deps: ResponseBreakpointDeps) {
  const { eventBus, breakpoints, inFlight, ruleContexts, rewriteContexts } = deps;

  return function handleResponseBreakpoint(ctx: IContext, rule: Rule, callback: ErrorCallback): void {
    const exchange = inFlight.get(ctx.uuid);
    const res = ctx.serverToProxyResponse;
    if (!res || !exchange) {
      callback();
      return;
    }

    // Mirrors handleScriptResponseHook: `chunks` is the real (uncapped)
    // upstream body that gets forwarded to the client once resumed;
    // `displayCapture` is a separate, capped copy purely for the dashboard.
    // A single capped `BodyCapture` used for both (as this used to do) would
    // truncate the body actually sent to the client at MAX_CAPTURED_BODY_BYTES
    // for a response the user resumed without editing, and re-wrapping that
    // already-capped buffer for the snapshot would also silently launder
    // `responseBodyTruncated` back to `false` — see issue #95.
    const displayCapture = new BodyCapture();
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => {
      displayCapture.add(chunk);
      chunks.push(chunk);
    });
    // `serverToProxyResponse` is paused by ProxyEngine before this hook
    // runs; without resuming it here, it never emits 'data'/'end' and the
    // wait below deadlocks forever (same reasoning as the mock branch above).
    res.resume();

    const pause = () => {
      const rawBody = Buffer.concat(chunks);
      // See handleRequestBreakpoint's identical fix above: without this,
      // `chunks` and `rawBody` both hold the full response body in memory
      // at once for as long as this closure is alive.
      chunks.length = 0;
      const snapshot: CapturedExchange = { ...exchange, breakpoint: 'response' };
      snapshot.statusCode = res.statusCode;
      snapshot.statusMessage = res.statusMessage;
      snapshot.responseHeaders = { ...res.headers };
      snapshot.responseBodySize = rawBody.length;
      displayCapture.applyTo(snapshot, 'response');

      const payload: BreakpointResponsePayload = {
        phase: 'response',
        id: ctx.uuid,
        status: res.statusCode ?? 200,
        statusMessage: res.statusMessage,
        headers: flattenHeaders(res.headers),
        body: snapshot.responseBody,
        // Read directly off `displayCapture` — see the request phase's
        // identical fix above for why this must not go through a re-wrap of
        // an already-capped buffer.
        bodyTruncated: displayCapture.isTruncated,
      };
      eventBus.emit('breakpointHit', { exchange: snapshot, payload });

      breakpoints.wait(ctx.uuid, 'response').then((command) => {
        if (command.action === 'abort') {
          inFlight.delete(ctx.uuid);
          ruleContexts.delete(ctx.uuid);
          rewriteContexts.delete(ctx.uuid);
          exchange.error = `rule "${rule.name}": response aborted via breakpoint (connection closed)`;
          exchange.finishedAt = Date.now();
          exchange.durationMs = exchange.finishedAt - exchange.startedAt;
          attachTiming(exchange, ctx);
          attachCertificate(exchange, ctx);
          attachUpstreamProtocol(exchange, ctx);
          eventBus.emit('response', exchange);
          ctx.proxyToClientResponse.destroy();
          // Deliberately never calls `callback`: leaving it uncalled stops
          // headers/body from ever reaching the client, same convention as
          // the request-phase abort above.
          return;
        }

        const edits = command.edits;
        if (edits?.status !== undefined) res.statusCode = edits.status;
        if (edits?.statusMessage !== undefined) res.statusMessage = edits.statusMessage;
        if (edits?.headers) res.headers = { ...edits.headers };
        // Same reasoning as the request phase: the edited body's length may
        // differ, so drop content-length and let it go out chunked.
        // Case-insensitive: a breakpoint edit is typed by hand in the
        // dashboard and can carry any casing, unlike headers straight off
        // the wire (always lowercased by Node).
        deleteHeader(res.headers, 'content-length');
        const finalBody = edits?.body !== undefined ? Buffer.from(edits.body, 'base64') : rawBody;

        exchange.statusCode = res.statusCode;
        exchange.statusMessage = res.statusMessage;
        exchange.responseHeaders = { ...res.headers };
        exchange.responseBodySize = finalBody.length;
        BodyCapture.of(finalBody).applyTo(exchange, 'response');
        exchange.finishedAt = Date.now();
        exchange.durationMs = exchange.finishedAt - exchange.startedAt;
        attachTiming(exchange, ctx);
        attachCertificate(exchange, ctx);
        attachUpstreamProtocol(exchange, ctx);

        ctx.onResponseData((_dataCtx, _chunk, cb) => cb(undefined, Buffer.alloc(0)));
        ctx.onResponseEnd((_endCtx, cb) => {
          if (finalBody.length > 0) ctx.proxyToClientResponse.write(finalBody);
          eventBus.emit('response', exchange);
          inFlight.delete(ctx.uuid);
          ruleContexts.delete(ctx.uuid);
          rewriteContexts.delete(ctx.uuid);
          return cb();
        });

        callback();
      });
    };

    // `readableEnded`, not `.complete` (h2 upstream responses — issue #166
    // — have no such property at all; see `ProxyEngine.pumpChunks`'s own
    // doc comment for why this is the more precise check anyway).
    if (res.readableEnded) pause();
    else res.once('end', pause);
  };
}
