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
 * The timer is only ever armed while `activeCount` (requests awaiting a
 * response, plus open WebSocket connections) is zero — disarmed the moment
 * either goes from 0 to 1 (`request`/`wsOpen`), rearmed only once the last
 * one finishes (`response`/`wsClose` bringing it back to 0) — so a slow
 * upstream response, or a WebSocket connection that's open but between
 * frames, can never trigger an idle shutdown mid-flight the way rearming
 * purely on `response`/frame activity could. It's armed immediately on
 * start too, as a grace period counted from startup rather than from the
 * first request.
 *
 * One known gap: a `mock` rule's `simulate: "timeout"` action (see
 * `proxyServer.ts`) deliberately emits `request` but never `response` — by
 * design, there's no signal for when (if ever) the client on the other end
 * gives up. Matching such a rule leaves `activeCount` permanently
 * incremented, disabling `--exit-on-idle` for the rest of the process's
 * life. Accepted as a narrow, documented trade-off rather than adding a
 * second "give up waiting" timer purely for that one deliberately-hung-
 * connection testing feature.
 */
export function startIdleWatcher(eventBus: DetourEventBus, idleMs: number, onIdle: () => void): IdleWatcherHandle {
  // Optional — undefined whenever no timer is currently pending (before the
  // first arm, or while `activeCount > 0`). `clearTimeout` is a safe no-op
  // on `undefined`, so every call site below can clear it unconditionally.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeCount = 0;

  const disarm = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  const arm = (): void => {
    disarm();
    if (activeCount > 0) return;
    const next = setTimeout(onIdle, idleMs);
    // Never keeps the process alive by itself — a real shutdown path
    // (SIGINT/SIGTERM/this same idle timer) is what should decide that.
    next.unref();
    timer = next;
  };

  const handleStart = (): void => {
    activeCount += 1;
    disarm();
  };
  const handleEnd = (): void => {
    activeCount = Math.max(0, activeCount - 1);
    arm();
  };
  eventBus.on('request', handleStart);
  eventBus.on('response', handleEnd);
  eventBus.on('wsOpen', handleStart);
  eventBus.on('wsClose', handleEnd);

  arm();

  return {
    stop(): void {
      disarm();
      eventBus.off('request', handleStart);
      eventBus.off('response', handleEnd);
      eventBus.off('wsOpen', handleStart);
      eventBus.off('wsClose', handleEnd);
    },
  };
}
