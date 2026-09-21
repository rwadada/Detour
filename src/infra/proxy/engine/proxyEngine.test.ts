import { EventEmitter } from 'node:events';
import type http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { hashPassword } from '../../../domain/auth/passwordHash';
import * as proxyAuth from '../../../domain/auth/proxyAuth';
import type { ProxyAuthCredentials } from '../../../domain/auth/proxyAuth';
import type { ExchangeTiming, UpstreamCertificate } from '../../../domain/exchange/types';
import { ProxyEngine } from './proxyEngine';

/** Builds just enough of an `IncomingMessage` for `parseHostAndPort` — it only ever reads `.url`/`.headers`. */
function fakeRequest(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage;
}

describe('ProxyEngine.parseHost', () => {
  it('splits host:port on the last colon', () => {
    expect(ProxyEngine.parseHost('example.com:8080')).toEqual({ host: 'example.com', port: 8080 });
  });

  it('falls back to defaultPort when no port is given', () => {
    expect(ProxyEngine.parseHost('example.com', 443)).toEqual({ host: 'example.com', port: 443 });
  });

  it('unwraps a bracketed IPv6 literal with a port', () => {
    expect(ProxyEngine.parseHost('[::1]:8443')).toEqual({ host: '::1', port: 8443 });
  });

  it('unwraps a bracketed IPv6 literal with no port, falling back to defaultPort', () => {
    expect(ProxyEngine.parseHost('[::1]', 443)).toEqual({ host: '::1', port: 443 });
  });

  it('treats an unbracketed IPv6 literal (multiple colons, no port) as the whole host rather than mis-splitting on the last colon', () => {
    // No brackets here — matches how a bare `Host: ::1` would arrive. Per RFC
    // 3986 a client pairing an IPv6 literal with an explicit port must
    // bracket it, so a bracket-less multi-colon value is never split.
    expect(ProxyEngine.parseHost('::1', 443)).toEqual({ host: '::1', port: 443 });
  });
});

describe('ProxyEngine.parseHostAndPort', () => {
  it('parses an absolute-form URL (plain HTTP forward-proxy request) and rewrites req.url down to the bare path', () => {
    const req = fakeRequest('http://api.example.com:8080/users/1?x=2');
    const result = ProxyEngine.parseHostAndPort(req, 80);
    expect(result).toEqual({ host: 'api.example.com', port: 8080 });
    expect(req.url).toBe('/users/1?x=2');
  });

  it('defaults an absolute-form URL with no path to "/"', () => {
    const req = fakeRequest('http://api.example.com');
    ProxyEngine.parseHostAndPort(req, 80);
    expect(req.url).toBe('/');
  });

  it('falls back to the Host header for an origin-form URL (MITM-decrypted HTTPS, HTTP/1.1)', () => {
    const req = fakeRequest('/users/1', { host: 'api.example.com:8443' });
    expect(ProxyEngine.parseHostAndPort(req, 443)).toEqual({ host: 'api.example.com', port: 8443 });
  });

  it('falls back to the :authority pseudo-header when Host is absent (HTTP/2 has no Host header)', () => {
    const req = fakeRequest('/users/1', { ':authority': 'api.example.com:8443' });
    expect(ProxyEngine.parseHostAndPort(req, 443)).toEqual({ host: 'api.example.com', port: 8443 });
  });

  it('returns null when neither an absolute-form URL nor a Host/:authority is present', () => {
    const req = fakeRequest('/users/1');
    expect(ProxyEngine.parseHostAndPort(req, 443)).toBeNull();
  });

  it('parses a bracketed IPv6 Host header', () => {
    const req = fakeRequest('/users/1', { host: '[::1]:8443' });
    expect(ProxyEngine.parseHostAndPort(req, 443)).toEqual({ host: '::1', port: 8443 });
  });
});

/** A minimal `WebSocket`-shaped double: just `readyState`/`close`, which is all `closeStillOpenLeg`/`wsError` touch. */
function fakeSocket(readyState: number) {
  const closeCalls: unknown[][] = [];
  return { readyState, close: (...args: unknown[]) => closeCalls.push(args), closeCalls };
}

/** Exposes `ProxyEngine`'s private WebSocket cross-signaling methods for direct testing, without needing a real socket pair. */
function engineInternals() {
  return new ProxyEngine() as unknown as {
    closeStillOpenLeg(ctx: { clientWs?: unknown; serverWs?: unknown }, code?: number, message?: Buffer): void;
    wsError(ctx: { clientWs?: unknown; serverWs?: unknown }, err: Error): void;
  };
}

describe('ProxyEngine WebSocket close/error cross-signaling', () => {
  it('closes the still-open client leg once the server leg has already closed', () => {
    const client = fakeSocket(WebSocket.OPEN);
    const server = fakeSocket(WebSocket.CLOSED);
    engineInternals().closeStillOpenLeg({ clientWs: client, serverWs: server });
    expect(client.closeCalls).toHaveLength(1);
  });

  it('closes the still-open server leg once the client leg has already closed, forwarding code/message', () => {
    const client = fakeSocket(WebSocket.CLOSED);
    const server = fakeSocket(WebSocket.OPEN);
    engineInternals().closeStillOpenLeg({ clientWs: client, serverWs: server }, 1000, Buffer.from('done'));
    expect(server.closeCalls).toEqual([[1000, Buffer.from('done')]]);
  });

  it('closes with no arguments for code 1005 ("no status received"), which close() rejects as an explicit argument', () => {
    const client = fakeSocket(WebSocket.CLOSED);
    const server = fakeSocket(WebSocket.OPEN);
    engineInternals().closeStillOpenLeg({ clientWs: client, serverWs: server }, 1005, Buffer.alloc(0));
    expect(server.closeCalls).toEqual([[]]);
  });

  it('does nothing when both legs are already in the same state', () => {
    const client = fakeSocket(WebSocket.CLOSED);
    const server = fakeSocket(WebSocket.CLOSED);
    engineInternals().closeStillOpenLeg({ clientWs: client, serverWs: server });
    expect(client.closeCalls).toHaveLength(0);
    expect(server.closeCalls).toHaveLength(0);
  });

  it('does nothing when the server leg does not exist yet (e.g. an error before connectUpstreamWebSocket ran)', () => {
    const client = fakeSocket(WebSocket.OPEN);
    engineInternals().closeStillOpenLeg({ clientWs: client, serverWs: undefined });
    expect(client.closeCalls).toHaveLength(0);
  });

  it('wsError cross-signals just like wsClose, closing the still-open leg', () => {
    const client = fakeSocket(WebSocket.OPEN);
    const server = fakeSocket(WebSocket.CLOSED);
    engineInternals().wsError({ clientWs: client, serverWs: server }, new Error('boom'));
    expect(client.closeCalls).toHaveLength(1);
  });
});

/**
 * Minimal `net.Socket`-shaped double: an `EventEmitter` with a `connecting`
 * flag plus the `tls.TLSSocket` surface `captureUpstreamCertificate` reads
 * (issue #160) — `getPeerCertificate`/`authorized`/`authorizationError`.
 * `tls` defaults to an empty peer certificate (no SSL info at all), which
 * `captureUpstreamCertificate` correctly reads as "no certificate captured"
 * — the right default for every plain-HTTP test below, and harmless for an
 * HTTPS test that doesn't care about certificate capture specifically.
 */
function fakeConnectingSocket(
  connecting: boolean,
  tls?: { peerCertificate?: Record<string, unknown>; authorized?: boolean; authorizationError?: Error | null },
): Socket {
  return Object.assign(new EventEmitter(), {
    connecting,
    getPeerCertificate: () => tls?.peerCertificate ?? {},
    authorized: tls?.authorized ?? true,
    authorizationError: tls?.authorizationError ?? null,
  }) as unknown as Socket;
}

/** A `trackSocketTiming` callbacks pair that does nothing — for a test that only cares about `timing`, not `onReady`/`onCertificate`. */
function noopCallbacks(): { onReady: () => void; onCertificate: () => void } {
  return { onReady: () => undefined, onCertificate: () => undefined };
}

/** Exposes `ProxyEngine`'s private DNS/TCP/TLS timing tracker (issue #140) for direct testing, without needing a real socket connection. */
function timingInternals() {
  return new ProxyEngine() as unknown as {
    trackSocketTiming(
      socket: Socket,
      isSSL: boolean,
      timing: ExchangeTiming,
      callbacks: { onReady: (readyAt: number) => void; onCertificate: (cert: UpstreamCertificate) => void },
    ): void;
  };
}

describe('ProxyEngine.trackSocketTiming', () => {
  it('measures dns/tcp for a plain HTTP socket and reports ready on connect (no TLS phase)', () => {
    const socket = fakeConnectingSocket(true);
    const timing: ExchangeTiming = {};
    let readyAt: number | undefined;
    timingInternals().trackSocketTiming(socket, false, timing, {
      ...noopCallbacks(),
      onReady: (at) => {
        readyAt = at;
      },
    });

    socket.emit('lookup');
    socket.emit('connect');

    expect(timing.dnsMs).toBeDefined();
    expect(timing.tcpMs).toBeDefined();
    expect(timing.tlsMs).toBeUndefined();
    expect(readyAt).toBeDefined();
  });

  it('waits for secureConnect (not connect) before reporting ready on an HTTPS socket, and measures the TLS phase', () => {
    const socket = fakeConnectingSocket(true);
    const timing: ExchangeTiming = {};
    let readyAt: number | undefined;
    timingInternals().trackSocketTiming(socket, true, timing, {
      ...noopCallbacks(),
      onReady: (at) => {
        readyAt = at;
      },
    });

    socket.emit('lookup');
    socket.emit('connect');
    expect(readyAt).toBeUndefined();

    socket.emit('secureConnect');
    expect(timing.tlsMs).toBeDefined();
    expect(readyAt).toBeDefined();
  });

  it('omits dnsMs when no lookup event fires (an IP-literal host)', () => {
    const socket = fakeConnectingSocket(true);
    const timing: ExchangeTiming = {};
    timingInternals().trackSocketTiming(socket, false, timing, noopCallbacks());

    socket.emit('connect');

    expect(timing.dnsMs).toBeUndefined();
    expect(timing.tcpMs).toBeDefined();
  });

  it('skips straight to ready with no phases measured and flags connectionReused for a socket that is not connecting (a reused keep-alive socket, issue #162)', () => {
    const socket = fakeConnectingSocket(false);
    const timing: ExchangeTiming = {};
    let readyAt: number | undefined;
    timingInternals().trackSocketTiming(socket, true, timing, {
      ...noopCallbacks(),
      onReady: (at) => {
        readyAt = at;
      },
    });

    expect(readyAt).toBeDefined();
    expect(timing.dnsMs).toBeUndefined();
    expect(timing.tcpMs).toBeUndefined();
    expect(timing.tlsMs).toBeUndefined();
    expect(timing.connectionReused).toBe(true);
  });

  it('leaves connectionReused unset for a fresh (still-connecting) socket', () => {
    const socket = fakeConnectingSocket(true);
    const timing: ExchangeTiming = {};
    timingInternals().trackSocketTiming(socket, false, timing, noopCallbacks());

    socket.emit('lookup');
    socket.emit('connect');

    expect(timing.connectionReused).toBeUndefined();
  });

  it("measures dnsMs/tcpMs from when the socket was actually handed to it, not from an earlier caller timestamp (issue #162's own Copilot finding: a bounded maxSockets can now queue a request before a socket exists, and that queue wait must not leak into DNS/TCP)", () => {
    // Fake timers (which vitest's default preset also applies to `Date`)
    // make the "time elapsed before a socket existed" simulation below
    // exact rather than a real setTimeout delay racing actual wall-clock
    // jitter on a loaded CI runner — this test's whole point is measuring
    // a handful of milliseconds precisely, so it can't tolerate that noise.
    vi.useFakeTimers();
    try {
      const socket = fakeConnectingSocket(true);
      const timing: ExchangeTiming = {};

      // Simulates a request that sat in the Agent's queue for a while before
      // a socket was even created — trackSocketTiming only runs once that
      // happens (on the request's 'socket' event), so this advance is
      // deliberately *before* the call below, unseen by it, the same way a
      // real queue wait would be invisible to whatever timestamp
      // trackSocketTiming captures.
      vi.advanceTimersByTime(30);

      timingInternals().trackSocketTiming(socket, false, timing, noopCallbacks());
      socket.emit('lookup');

      // If this were measured from a timestamp captured before the 30ms
      // queue wait above, dnsMs would be 30; measured from when this
      // actually started running, it's exactly 0 instead.
      expect(timing.dnsMs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures the upstream certificate off secureConnect (issue #160) and caches it for a socket reused by a later exchange', () => {
    const peerCertificate = {
      subject: { CN: 'example.com' },
      issuer: { CN: 'Example CA' },
      valid_from: 'Jan 1 00:00:00 2024 GMT',
      valid_to: 'Jan 1 00:00:00 2025 GMT',
      subjectaltname: 'DNS:example.com',
      fingerprint256: 'AA:BB:CC',
    };
    const socket = fakeConnectingSocket(true, { peerCertificate, authorized: true });
    const timing: ExchangeTiming = {};
    const engine = timingInternals();
    let firstCert: UpstreamCertificate | undefined;
    engine.trackSocketTiming(socket, true, timing, {
      onReady: () => undefined,
      onCertificate: (cert) => {
        firstCert = cert;
      },
    });
    socket.emit('secureConnect');

    expect(firstCert).toEqual({
      subject: 'CN=example.com',
      issuer: 'CN=Example CA',
      validFrom: peerCertificate.valid_from,
      validTo: peerCertificate.valid_to,
      subjectAltName: peerCertificate.subjectaltname,
      fingerprint256: peerCertificate.fingerprint256,
      authorized: true,
      authorizationError: undefined,
    });

    // The *same* socket, now reused (`connecting: false`) — as it would be
    // for a 2nd+ request over the same keep-alive connection (issue #162).
    // No 'secureConnect' fires again (a reused socket never re-handshakes),
    // so the only way this request's exchange can still get a certificate
    // at all is `certificatesBySocket`'s cache, keyed by this exact socket.
    Object.assign(socket, { connecting: false });
    const reuseTiming: ExchangeTiming = {};
    let reusedCert: UpstreamCertificate | undefined;
    engine.trackSocketTiming(socket, true, reuseTiming, {
      onReady: () => undefined,
      onCertificate: (cert) => {
        reusedCert = cert;
      },
    });

    expect(reusedCert).toEqual({ ...firstCert, fromReusedConnection: true });
  });

  it('joins a repeated RDN attribute (e.g. two OU values) with ", " instead of Array.prototype.toString\'s bare comma', () => {
    // Node types a repeated subject/issuer attribute as a string array, not
    // a string — `${value}` on an array stringifies via a bare comma join
    // with no separating space, garbling a multi-OU subject into something
    // like "OU=Engineering,DevOps" that reads as one run-on value.
    const peerCertificate = {
      subject: { O: 'Example Corp', OU: ['Engineering', 'DevOps'], CN: 'example.com' },
      issuer: { CN: 'Example CA' },
      valid_from: 'Jan 1 00:00:00 2024 GMT',
      valid_to: 'Jan 1 00:00:00 2025 GMT',
      fingerprint256: 'AA:BB:CC',
    };
    const socket = fakeConnectingSocket(true, { peerCertificate, authorized: true });
    let cert: UpstreamCertificate | undefined;
    timingInternals().trackSocketTiming(
      socket,
      true,
      {},
      {
        onReady: () => undefined,
        onCertificate: (c) => {
          cert = c;
        },
      },
    );
    socket.emit('secureConnect');

    expect(cert?.subject).toBe('O=Example Corp, OU=Engineering, DevOps, CN=example.com');
  });

  it('reports authorized: false with the reason when verification failed but the connection proceeded anyway (--insecure-upstream)', () => {
    const authorizationError = new Error('self signed certificate');
    const socket = fakeConnectingSocket(true, {
      peerCertificate: { subject: { CN: 'self-signed.example' }, fingerprint256: 'DD:EE:FF' },
      authorized: false,
      authorizationError,
    });
    const timing: ExchangeTiming = {};
    let cert: UpstreamCertificate | undefined;
    timingInternals().trackSocketTiming(socket, true, timing, {
      onReady: () => undefined,
      onCertificate: (c) => {
        cert = c;
      },
    });
    socket.emit('secureConnect');

    expect(cert?.authorized).toBe(false);
    expect(cert?.authorizationError).toBe('self signed certificate');
  });

  it('never calls onCertificate for a plain HTTP socket', () => {
    const socket = fakeConnectingSocket(true);
    const timing: ExchangeTiming = {};
    const onCertificate = vi.fn();
    timingInternals().trackSocketTiming(socket, false, timing, { onReady: () => undefined, onCertificate });

    socket.emit('lookup');
    socket.emit('connect');

    expect(onCertificate).not.toHaveBeenCalled();
  });
});

describe('ProxyEngine upstream agents (issue #162)', () => {
  it('configures both httpAgent and httpsAgent for keep-alive connection reuse', () => {
    const engine = new ProxyEngine() as unknown as { httpAgent: http.Agent; httpsAgent: http.Agent };
    const keepAliveOf = (agent: http.Agent) => (agent as unknown as { keepAlive: boolean }).keepAlive;

    expect(keepAliveOf(engine.httpAgent)).toBe(true);
    expect(keepAliveOf(engine.httpsAgent)).toBe(true);
    expect(engine.httpAgent.maxSockets).toBe(128);
    expect(engine.httpsAgent.maxSockets).toBe(128);
  });
});

/** Exposes `ProxyEngine`'s private `--proxy-auth` gate (issue #158), plus the `proxyAuth` field `listen` normally fills in, for direct testing without binding a port. */
function proxyAuthInternals(proxyAuth?: ProxyAuthCredentials) {
  const engine = new ProxyEngine() as unknown as {
    proxyAuth: ProxyAuthCredentials | undefined;
    guardProxyAuth(req: IncomingMessage, onDenied: () => void, onAllowed: () => void): void;
  };
  engine.proxyAuth = proxyAuth;
  return engine;
}

/** The decision `guardProxyAuth` reaches for `header`, as a promise so the scrypt verification it awaits has somewhere to settle. */
function guardDecision(engine: ReturnType<typeof proxyAuthInternals>, header?: string): Promise<'allowed' | 'denied'> {
  return new Promise((resolve) => {
    engine.guardProxyAuth(
      fakeRequest('/', header === undefined ? {} : { 'proxy-authorization': header }),
      () => resolve('denied'),
      () => resolve('allowed'),
    );
  });
}

describe('ProxyEngine proxy authentication gate (issue #158)', () => {
  const credentials: ProxyAuthCredentials = { username: 'agent', passwordHash: 'filled in below' };

  beforeAll(async () => {
    credentials.passwordHash = await hashPassword('hunter2');
  });

  it('allows every client when no credentials are configured', async () => {
    expect(await guardDecision(proxyAuthInternals())).toBe('allowed');
  });

  it('allows a client presenting the configured credentials', async () => {
    const header = `Basic ${Buffer.from('agent:hunter2', 'utf8').toString('base64')}`;
    expect(await guardDecision(proxyAuthInternals(credentials), header)).toBe('allowed');
  });

  it.each([
    ['no header at all', undefined],
    ['the wrong password', `Basic ${Buffer.from('agent:nope', 'utf8').toString('base64')}`],
    ['the wrong username', `Basic ${Buffer.from('mallory:hunter2', 'utf8').toString('base64')}`],
    ['another scheme', 'Bearer some-token'],
  ])('denies a client with %s', async (_label, header) => {
    expect(await guardDecision(proxyAuthInternals(credentials), header)).toBe('denied');
  });

  // Fails closed, and without an unhandled rejection: there's no failure of
  // the KDF that should be answered by proxying for the client anyway, and
  // an escaping rejection here would take the whole process down.
  it('denies the client when verification itself throws', async () => {
    const spy = vi.spyOn(proxyAuth, 'verifyProxyCredentials').mockRejectedValue(new Error('scrypt exploded'));
    try {
      expect(await guardDecision(proxyAuthInternals(credentials), 'Basic anything')).toBe('denied');
    } finally {
      spy.mockRestore();
    }
  });
});
