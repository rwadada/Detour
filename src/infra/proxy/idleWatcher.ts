import type { CapturedExchange, CapturedWebSocketConnection, ProxyErrorEvent } from '../../domain/exchange/types';
import type { DetourEventBus } from '../eventBus';

export interface IdleWatcherHandle {
  /** Stops watching and clears the pending timer — call on any shutdown path (SIGINT/SIGTERM, or the idle callback's own shutdown) so it never fires again or keeps the event loop alive. */
  stop(): void;
}

/**
 * `--exit-on-idle` (issue #20): calls `onIdle` once `idleMs` elapses with
 * nothing in flight — no HTTP request awaiting its response, and no open
 * WebSocket connection — letting a CI job that spun up `detour start` clean
 * itself up instead of hanging around forever waiting for a Ctrl+C that
 * will never come.
 *
 * The timer is only ever armed while nothing is tracked as in flight —
 * disarmed the instant something starts (`request`/`wsOpen`), rearmed only
 * once it (and everything else in flight) has ended. In-flight items are
 * tracked by id (`CapturedExchange`/`CapturedWebSocketConnection`'s `.id`,
 * from `ctx.uuid`) in a `Set` rather than a plain counter, for two reasons:
 * a `Set.delete` of an id that was never added (or already removed) is a
 * safe no-op, and a proxy-level `error` event (connection reset, TLS
 * failure mid-request, etc. — see `proxyServer.ts`'s `onError`) can end an
 * HTTP exchange without `response` ever firing for it, so `error` needs to
 * remove the same id too — a plain increment/decrement pair would have no
 * way to know an `error` should count as an "end" it hadn't already seen.
 * (WebSocket errors don't have this gap: `onWebSocketError` always emits
 * `wsClose` too.) It's armed immediately on start as well, as a grace
 * period counted from startup rather than from the first request.
 *
 * Two known, deliberately unaddressed gaps:
 *
 * - A `mock` rule's `simulate: "timeout"` action emits `request` but — by
 *   design — neither `response` nor an `error`; there's no signal for when
 *   (if ever) the client on the other end gives up. Matching such a rule
 *   leaves that one exchange's id tracked forever, disabling
 *   `--exit-on-idle` for the rest of the process's life. Accepted as a
 *   narrow trade-off rather than adding a second "give up waiting" timer
 *   purely for that one deliberately-hung-connection testing feature.
 * - `request` (see `handleRequest` below) only fires once the client's
 *   entire request body has finished arriving (`proxyServer.ts`'s
 *   `onRequestEnd`), so a slow/throttled upload is invisible to this
 *   watcher for its whole duration — the idle timer can elapse mid-upload
 *   if nothing else is in flight. Accepted rather than adding a new
 *   "upload started" event purely for this watcher's benefit; a
 *   `--exit-on-idle` value comfortably longer than any expected upload
 *   sidesteps it in practice.
 */
export function startIdleWatcher(eventBus: DetourEventBus, idleMs: number, onIdle: () => void): IdleWatcherHandle {
  // Undefined whenever no timer is currently pending (before the first arm,
  // or while something is in flight). `clearTimeout` is a safe no-op on
  // `undefined`, so every call site below can clear it unconditionally.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const activeHttp = new Set<string>();
  const activeWs = new Set<string>();

  const disarm = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  const arm = (): void => {
    disarm();
    if (activeHttp.size > 0 || activeWs.size > 0) return;
    const next = setTimeout(onIdle, idleMs);
    // Never keeps the process alive by itself — a real shutdown path
    // (SIGINT/SIGTERM/this same idle timer) is what should decide that.
    next.unref();
    timer = next;
  };

  const handleRequest = (exchange: Readonly<CapturedExchange>): void => {
    activeHttp.add(exchange.id);
    disarm();
  };
  const handleResponse = (exchange: Readonly<CapturedExchange>): void => {
    activeHttp.delete(exchange.id);
    arm();
  };
  const handleWsOpen = (connection: Readonly<CapturedWebSocketConnection>): void => {
    activeWs.add(connection.id);
    disarm();
  };
  const handleWsClose = (connection: Readonly<CapturedWebSocketConnection>): void => {
    activeWs.delete(connection.id);
    arm();
  };
  const handleError = (event: ProxyErrorEvent): void => {
    if (event.id === undefined) return;
    // `RULE_MOCK_ERROR`/`RULE_SCRIPT_ERROR` (see proxyServer.ts's
    // `tryResolveMock`/`tryLoadScriptModule` callers) are informational —
    // the rule failed, but the exchange itself keeps going (a fallback 500,
    // or the request/response forwarded unrewritten) and a real `response`
    // still follows for this same id. Every other `errorKind` reaching here
    // (the proxy-level `onError` catch-all — connection reset, TLS failure
    // mid-request, etc.) means the exchange is genuinely over with no
    // `response` coming, per this file's doc comment.
    if (event.errorKind === 'RULE_MOCK_ERROR' || event.errorKind === 'RULE_SCRIPT_ERROR') return;
    activeHttp.delete(event.id);
    activeWs.delete(event.id);
    arm();
  };

  eventBus.on('request', handleRequest);
  eventBus.on('response', handleResponse);
  eventBus.on('wsOpen', handleWsOpen);
  eventBus.on('wsClose', handleWsClose);
  eventBus.on('error', handleError);

  arm();

  return {
    stop(): void {
      disarm();
      eventBus.off('request', handleRequest);
      eventBus.off('response', handleResponse);
      eventBus.off('wsOpen', handleWsOpen);
      eventBus.off('wsClose', handleWsClose);
      eventBus.off('error', handleError);
    },
  };
}
