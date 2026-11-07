import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { CapturedExchange } from '../../../domain/exchange/types';
import { connectMatchUrl, formatHostPort } from '../../../domain/focus/focusPolicy';
import type { ProxyRuntimeState } from '../../../usecase/proxyRuntimeState';
import { resolveConnectRoute } from '../../../usecase/resolveConnectRoute';
import type { DetourEventBus } from '../../eventBus';
import { ProxyEngine } from '../engine/proxyEngine';
import { createThrottleTransform } from '../throttleTransform';

export interface InterceptOffConnectDeps {
  eventBus: DetourEventBus;
  runtimeState: ProxyRuntimeState;
}

/**
 * While intercept is off (globally, or for this one host via Focus), a
 * CONNECT tunnel is relayed byte-for-byte between the client and the real
 * upstream server instead of being terminated by our local per-host cert —
 * true TLS passthrough, since we never touch (or can see) the encrypted
 * bytes flowing through. A `route` rule still redirects the tunnel's
 * destination (matched on host/port only — there's no path/method to go on
 * without decrypting), and nothing about its contents is ever observable or
 * editable — but *where* it went and for how long is (see `tunnelExchange`
 * below), so a passthrough connection still shows up in the log table
 * instead of vanishing without a trace the moment Intercept is off.
 */
// eslint-disable-next-line max-lines-per-function -- CONNECT passthrough handler factory; tracked under issue #208 (issue #207)
export function createInterceptOffConnectHandler(deps: InterceptOffConnectDeps) {
  const { eventBus, runtimeState } = deps;

  // eslint-disable-next-line max-lines-per-function -- CONNECT passthrough lifecycle; tracked under issue #208 (issue #207)
  return function handleInterceptOffConnect(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = ProxyEngine.parseHostAndPort(req, 443);
    if (!target?.host) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const originalPort = target.port ?? 443;
    const snapshot = runtimeState.getSnapshot();
    const route = resolveConnectRoute(snapshot.ruleEngine, target.host, originalPort);
    const destHost = route?.host ?? target.host;
    const destPort = route?.port ?? originalPort;

    let tunnelExchange: CapturedExchange | undefined;
    let tunnelClosed = false;
    const closeTunnelExchange = (error?: string) => {
      if (!tunnelExchange || tunnelClosed) return;
      tunnelClosed = true;
      const finishedAt = Date.now();
      eventBus.emit('response', {
        ...tunnelExchange,
        finishedAt,
        durationMs: finishedAt - tunnelExchange.startedAt,
        error,
      });
    };

    let established = false;
    const upstream = net.connect({ host: destHost, port: destPort }, () => {
      const finishConnect = () => {
        if (socket.destroyed || upstream.destroyed) return;
        established = true;
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        tunnelExchange = {
          id: crypto.randomUUID(),
          method: 'CONNECT',
          url: connectMatchUrl(destHost, destPort),
          host: formatHostPort(destHost, destPort, 443),
          isSSL: true,
          protocol: 'HTTP/1.1',
          requestHeaders: {},
          requestBodySize: 0,
          responseBodySize: 0,
          startedAt: Date.now(),
          passthrough: true,
        };
        eventBus.emit('request', tunnelExchange);
        if (head.length > 0) upstream.write(head);
        const liveSnapshot = runtimeState.getSnapshot();
        const throttleState = liveSnapshot.throttleState;
        if (throttleState.enabled && (throttleState.upKbps > 0 || throttleState.packetLossPct > 0)) {
          socket.pipe(createThrottleTransform(throttleState.upKbps, throttleState.packetLossPct)).pipe(upstream);
        } else {
          socket.pipe(upstream);
        }
        if (throttleState.enabled && (throttleState.downKbps > 0 || throttleState.packetLossPct > 0)) {
          upstream.pipe(createThrottleTransform(throttleState.downKbps, throttleState.packetLossPct)).pipe(socket);
        } else {
          upstream.pipe(socket);
        }
      };
      const throttleState = runtimeState.getSnapshot().throttleState;
      const latency = throttleState.enabled ? throttleState.latencyMs : 0;
      if (latency > 0) setTimeout(finishConnect, latency);
      else finishConnect();
    });
    const teardown = () => {
      closeTunnelExchange();
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', (err) => {
      eventBus.emit('error', {
        errorKind: 'INTERCEPT_OFF_TUNNEL_ERROR',
        message: `passthrough tunnel to ${destHost}:${destPort} failed: ${err.message}`,
      });
      if (!established && !socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      closeTunnelExchange(err.message);
    });
    socket.on('error', teardown);
    socket.once('close', teardown);
    upstream.once('close', teardown);
  };
}
