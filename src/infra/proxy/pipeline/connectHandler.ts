import { isHostBlocked } from '../../../domain/blockHosts/blockHostsPolicy';
import type { BlockHostsState } from '../../../domain/exchange/types';
import { formatHostPort, isHostFocused } from '../../../domain/focus/focusPolicy';
import type { DetourEventBus } from '../../eventBus';
import { ProxyEngine } from '../engine/proxyEngine';
import type { OnConnectParams } from '../engine/types';
import type { createInterceptOffConnectHandler } from './interceptOffConnect';

/**
 * Dependencies read live at call time, not captured once at construction:
 * `blockHostsState`/`focusHosts`/`interceptEnabled` are all mutable in
 * `startProxyServer` (dashboard toggles), so this takes getters rather
 * than snapshotted values.
 */
export interface ConnectHandlerDeps {
  eventBus: DetourEventBus;
  getBlockHostsState: () => BlockHostsState;
  getFocusHosts: () => string[];
  getInterceptEnabled: () => boolean;
  handleInterceptOffConnect: ReturnType<typeof createInterceptOffConnectHandler>;
}

/**
 * The CONNECT tunnel's entry point: denies a Block Hosts match outright,
 * then either lets ProxyEngine MITM-decrypt it as usual (`callback()`) or
 * falls through to `handleInterceptOffConnect`'s raw passthrough while
 * Intercept is off (globally, or for this one host via Focus).
 */
export function createConnectHandler(deps: ConnectHandlerDeps): OnConnectParams {
  const { eventBus, getBlockHostsState, getFocusHosts, getInterceptEnabled, handleInterceptOffConnect } = deps;

  return function handleConnect(req, socket, head, callback) {
    // An unparseable target can't be checked against Block Hosts/Focus —
    // fall through to the normal intercept-enabled path (same as before
    // this feature), rather than treating "can't tell" as blocked/unfocused.
    const target = ProxyEngine.parseHostAndPort(req, 443);
    const formatted = target?.host ? formatHostPort(target.host, target.port ?? 443, 443) : undefined;
    const blockHostsState = getBlockHostsState();
    if (formatted && isHostBlocked(blockHostsState.hosts, formatted)) {
      eventBus.emit('error', {
        errorKind: 'BLOCKED_HOST',
        message: `blocked CONNECT to ${formatted} (${blockHostsState.mode})`,
      });
      if (blockHostsState.mode === 'reset') {
        socket.destroy();
      } else {
        socket.end(
          `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\ndetour: CONNECT to "${formatted}" blocked by Block Hosts\n`,
        );
      }
      return;
    }
    const focused = !formatted || isHostFocused(getFocusHosts(), formatted);
    if (getInterceptEnabled() && focused) {
      callback();
      return;
    }
    handleInterceptOffConnect(req, socket, head);
  };
}
