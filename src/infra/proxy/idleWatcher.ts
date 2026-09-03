import type { DetourEventBus } from '../eventBus';

export interface IdleWatcherHandle {
  /** Stops watching and clears the pending timer — call on any shutdown path (SIGINT/SIGTERM, or the idle callback's own shutdown) so it never fires again or keeps the event loop alive. */
  stop(): void;
}

/**
 * `--exit-on-idle` (issue #20): calls `onIdle` once `idleMs` elapses with no
 * proxied activity — no HTTP request finishing, and no WebSocket
 * opening/framing — letting a CI job that spun up `detour start` clean
 * itself up instead of hanging around forever waiting for a Ctrl+C that
 * will never come.
 *
 * The timer is armed immediately on start (a grace period counted from
 * startup, not from the first request) and rearmed on every activity event;
 * `response` (rather than `request`) is used for HTTP so a long-running
 * request in flight counts as activity for its whole duration, not just at
 * the moment it started.
 */
export function startIdleWatcher(eventBus: DetourEventBus, idleMs: number, onIdle: () => void): IdleWatcherHandle {
  // Optional — undefined until the first `arm()` call below (not yet the
  // case when `stop()` is called before that ever happens). `clearTimeout`
  // is a safe no-op on `undefined`, so every call site below can clear it
  // unconditionally.
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (): void => {
    clearTimeout(timer);
    const next = setTimeout(onIdle, idleMs);
    // Never keeps the process alive by itself — a real shutdown path
    // (SIGINT/SIGTERM/this same idle timer) is what should decide that.
    next.unref();
    timer = next;
  };

  const handleResponse = (): void => arm();
  const handleWsOpen = (): void => arm();
  const handleWsFrame = (): void => arm();
  eventBus.on('response', handleResponse);
  eventBus.on('wsOpen', handleWsOpen);
  eventBus.on('wsFrame', handleWsFrame);

  arm();

  return {
    stop(): void {
      clearTimeout(timer);
      eventBus.off('response', handleResponse);
      eventBus.off('wsOpen', handleWsOpen);
      eventBus.off('wsFrame', handleWsFrame);
    },
  };
}
