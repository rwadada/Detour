import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { CapturedExchange, ThrottleState } from '../../../domain/exchange/types';
import { connectMatchUrl, formatHostPort } from '../../../domain/focus/focusPolicy';
import { resolveConnectRoute } from '../../../usecase/resolveConnectRoute';
import type { RuleEngine } from '../../../usecase/ruleEngine';
import type { DetourEventBus } from '../../eventBus';
import { ProxyEngine } from '../engine/proxyEngine';
import { createThrottleTransform } from '../throttleTransform';

/**
 * Dependencies read live at call time, not captured once at construction:
 * `ruleEngine` and `throttleState` are both mutable in `startProxyServer`
 * (a Rule Profile switch, a dashboard Throttle toggle), so this takes
 * getters rather than snapshotted values — a plain parameter would freeze
 * this handler to whatever was true the moment the proxy started.
 */
export interface InterceptOffConnectDeps {
  eventBus: DetourEventBus;
  getRuleEngine: () => RuleEngine | undefined;
  getThrottleState: () => ThrottleState;
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
export function createInterceptOffConnectHandler(deps: InterceptOffConnectDeps) {
  const { eventBus, getRuleEngine, getThrottleState } = deps;

  return function handleInterceptOffConnect(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = ProxyEngine.parseHostAndPort(req, 443);
    if (!target?.host) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const originalPort = target.port ?? 443;
    const route = resolveConnectRoute(getRuleEngine(), target.host, originalPort);
    const destHost = route?.host ?? target.host;
    const destPort = route?.port ?? originalPort;

    // Recorded as a `CapturedExchange` the moment the tunnel is actually
    // established (in `finishConnect` below) — the tunnel's bytes are never
    // decrypted, so this is the one thing about it that's ever observable:
    // *where* it went and for how long, not what was said. `passthrough:
    // true` flags every other field (headers, body, status) as the
    // meaningless placeholder it is rather than real captured data — see
    // that field's own doc comment. Published through the same `request`/
    // `response` events (and so the same backlog/broadcast path) as a
    // decrypted exchange rather than a new event type, precisely so it
    // shows up in the existing log table/Group by host with no separate
    // plumbing.
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

    // Once the tunnel is established, `socket` carries raw (opaque, possibly
    // mid-TLS-handshake) bytes end-to-end — an error past that point must
    // just tear the connection down, never write an HTTP status line into
    // what the client now treats as a byte stream.
    let established = false;
    const upstream = net.connect({ host: destHost, port: destPort }, () => {
      // Establishing (and throttling) the tunnel happens behind Throttle's
      // latency delay, same as the MITM path's onRequest below — but a
      // teardown (client/upstream error or close) can land during that
      // delay, so re-check both ends are still alive before touching them.
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
        const throttleState = getThrottleState();
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
      const throttleState = getThrottleState();
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
      // Node emits 'error' before 'close' on a net.Socket, so this always
      // lands before `teardown`'s own (then no-op, thanks to `tunnelClosed`)
      // call below — the only reason the exchange's `error` field is ever
      // actually populated instead of a plain clean close.
      closeTunnelExchange(err.message);
    });
    socket.on('error', teardown);
    socket.once('close', teardown);
    upstream.once('close', teardown);
  };
}
