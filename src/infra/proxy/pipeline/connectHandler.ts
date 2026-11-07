import { isHostBlocked } from '../../../domain/blockHosts/blockHostsPolicy';
import { formatHostPort, isHostFocused } from '../../../domain/focus/focusPolicy';
import type { ProxyRuntimeState } from '../../../usecase/proxyRuntimeState';
import type { DetourEventBus } from '../../eventBus';
import { ProxyEngine } from '../engine/proxyEngine';
import type { OnConnectParams } from '../engine/types';
import type { createInterceptOffConnectHandler } from './interceptOffConnect';

export interface ConnectHandlerDeps {
  eventBus: DetourEventBus;
  runtimeState: ProxyRuntimeState;
  handleInterceptOffConnect: ReturnType<typeof createInterceptOffConnectHandler>;
}

/**
 * The CONNECT tunnel's entry point: denies a Block Hosts match outright,
 * then either lets ProxyEngine MITM-decrypt it as usual (`callback()`) or
 * falls through to `handleInterceptOffConnect`'s raw passthrough while
 * Intercept is off (globally, or for this one host via Focus).
 */
export function createConnectHandler(deps: ConnectHandlerDeps): OnConnectParams {
  const { eventBus, runtimeState, handleInterceptOffConnect } = deps;

  return function handleConnect(req, socket, head, callback) {
    const target = ProxyEngine.parseHostAndPort(req, 443);
    const formatted = target?.host ? formatHostPort(target.host, target.port ?? 443, 443) : undefined;
    const snapshot = runtimeState.getSnapshot();
    if (formatted && isHostBlocked(snapshot.blockHostsState.hosts, formatted)) {
      eventBus.emit('error', {
        errorKind: 'BLOCKED_HOST',
        message: `blocked CONNECT to ${formatted} (${snapshot.blockHostsState.mode})`,
      });
      if (snapshot.blockHostsState.mode === 'reset') {
        socket.destroy();
      } else {
        socket.end(
          `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\ndetour: CONNECT to "${formatted}" blocked by Block Hosts\n`,
        );
      }
      return;
    }
    const focused = !formatted || isHostFocused(snapshot.focusHosts, formatted);
    if (snapshot.interceptEnabled && focused) {
      callback();
      return;
    }
    handleInterceptOffConnect(req, socket, head);
  };
}
