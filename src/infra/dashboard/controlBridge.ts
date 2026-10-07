import type { BlockHostsState, CapturedExchange, ThrottleState } from '../../domain/exchange/types';
import type { DetourEventBus } from '../eventBus';
import type { ControlDeps } from './controlServer';

/** How long a throttle / block-hosts change may take before the control API gives up waiting for the proxy to confirm it. */
const APPLY_TIMEOUT_MS = 3000;

/**
 * Sends `command` on the event bus and resolves with the state the proxy
 * announces on `confirmation` — the proxy applies these asynchronously (see
 * `proxyServer.ts`), so "the request returned" would otherwise not mean "the
 * traffic that follows is throttled". Rejects if nothing confirms in time
 * (no proxy is listening, e.g. in a unit test).
 */
export function applyAndConfirm<S>(
  eventBus: DetourEventBus,
  send: () => void,
  confirmation: 'throttleChanged' | 'blockHostsChanged',
): Promise<S> {
  return new Promise<S>((resolve, reject) => {
    const timer = setTimeout(() => {
      eventBus.off(confirmation, onConfirmed as never);
      reject(new Error(`The proxy did not confirm the change within ${APPLY_TIMEOUT_MS} ms`));
    }, APPLY_TIMEOUT_MS);
    const onConfirmed = (state: S) => {
      clearTimeout(timer);
      eventBus.off(confirmation, onConfirmed as never);
      resolve(state);
    };
    eventBus.on(confirmation, onConfirmed as never);
    send();
  });
}

/** What `startDashboardServer` has in hand that the control API drives (see `ControlDeps`). */
export interface ControlBridgeSources {
  eventBus: DetourEventBus;
  getRuleEngine: ControlDeps['getRuleEngine'];
  ensureRuleEngine: ControlDeps['ensureRuleEngine'];
  profiles: ControlDeps['profiles'];
  backlog: { toArray(): CapturedExchange[]; clear(): void };
  version: string | undefined;
}

/** Builds `ControlDeps` from the dashboard server's own state, so the control API shares it rather than duplicating it. */
export function createControlDeps(sources: ControlBridgeSources): ControlDeps {
  const { eventBus } = sources;
  return {
    getRuleEngine: sources.getRuleEngine,
    ensureRuleEngine: sources.ensureRuleEngine,
    profiles: sources.profiles,
    exchanges: () => sources.backlog.toArray(),
    clearExchanges: () => sources.backlog.clear(),
    setThrottle: (state: ThrottleState) =>
      applyAndConfirm<ThrottleState>(eventBus, () => eventBus.emit('setThrottle', state), 'throttleChanged'),
    setBlockHosts: (state: BlockHostsState) =>
      applyAndConfirm<BlockHostsState>(eventBus, () => eventBus.emit('setBlockHosts', state), 'blockHostsChanged'),
    version: sources.version,
  };
}
