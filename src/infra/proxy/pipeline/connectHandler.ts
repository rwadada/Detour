import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { AutoPassthroughHosts } from '../../../domain/autoPassthrough/clientCertRejection';
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
  /** Hosts whose clients refused Detour's certificate (auto TLS passthrough); omitted when that's turned off. */
  autoPassthroughHosts?: AutoPassthroughHosts;
}

/**
 * The CONNECT tunnel's entry point: denies a Block Hosts match outright,
 * then either lets ProxyEngine MITM-decrypt it as usual (`callback()`) or
 * falls through to `handleInterceptOffConnect`'s raw passthrough while
 * Intercept is off (globally, or for this one host via Focus) or once a
 * client has refused Detour's certificate for this host (auto TLS
 * passthrough) — MITM-ing it again would only break that client again.
 */
export function createConnectHandler(deps: ConnectHandlerDeps): OnConnectParams {
  const { eventBus, runtimeState, handleInterceptOffConnect, autoPassthroughHosts } = deps;

  /** Whether this client refused Detour's certificate for this exact target recently — keyed the way `ProxyEngine` records a MITM tunnel (see `MitmTunnelInfo`). */
  const refusedBefore = (req: IncomingMessage, socket: Duplex): boolean => {
    if (!autoPassthroughHosts) return false;
    const { host, port } = ProxyEngine.parseHost(req.url ?? '', 443);
    const clientAddress = (socket as Partial<Socket>).remoteAddress;
    return autoPassthroughHosts.has({ host, port: port ?? 443, clientAddress });
  };

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
    // A host put in Focus explicitly is one the user asked to intercept; a
    // refusal doesn't override that (an empty Focus list asks for nothing).
    const explicitlyFocused = focused && snapshot.focusHosts.length > 0;
    if (snapshot.interceptEnabled && focused && (explicitlyFocused || !refusedBefore(req, socket))) {
      callback();
      return;
    }
    handleInterceptOffConnect(req, socket, head);
  };
}
