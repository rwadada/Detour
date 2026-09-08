import http from 'node:http';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import { DetourEventBus } from '../eventBus';
import { computeAllowedHostnames, startDashboardServer, type DashboardServerHandle } from './dashboardServer';

// eslint-disable-next-line sonarjs/no-hardcoded-ip -- private-range test fixture, not a real address.
const FAKE_LAN_ADDRESS = '192.168.1.5';

/**
 * Covers the `Origin`/`Host` allowlists added for issue #92 (CSWSH / DNS
 * rebinding): a WebSocket handshake isn't subject to the browser's
 * same-origin policy, so without `verifyClient` any web page — on any
 * origin — could open `/ws` and read the live traffic backlog, rewrite
 * `rules.json`, or SSRF via `replay`. `dashboardServer.dashboardPassword.test.ts`
 * already exercises the (unrelated, optional) password gate on top of an
 * always-allowed `Origin`; this file exercises the allowlist itself.
 *
 * Every "accepted" case here connects via `localhost` (matching every other
 * `dashboardServer.*.test.ts` file, and sidestepping this machine's actual
 * IPv4/IPv6 loopback binding behavior, which isn't what's under test) while
 * spoofing the header under test (`Origin`, or `Host` via the `ws`/`http`
 * client's own `headers` option) — the same technique a real DNS-rebinding
 * page or a forged `Origin` would use, just without needing a second real
 * network path to this dashboard.
 */
describe('startDashboardServer — Origin/Host allowlist (issue #92)', () => {
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets = [];
    await handle?.stop();
    handle = undefined;
  });

  function waitForMessage(
    socket: WebSocket,
    predicate: (message: DashboardServerMessage) => boolean,
    timeoutMs = 2000,
  ): Promise<DashboardServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a matching message')), timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as DashboardServerMessage;
        if (predicate(message)) {
          clearTimeout(timer);
          socket.off('message', onMessage);
          resolve(message);
        }
      };
      socket.on('message', onMessage);
      socket.on('error', reject);
    });
  }

  /**
   * A rejected handshake never completes and never sends anything —
   * surfaced to the client as an 'error', not a 'close' with a code.
   * Resolves `'rejected'`/`'opened'` (rather than settling the promise
   * itself either way) so every call site still carries its own explicit
   * `expect(...)`, matching this file's other assertions rather than
   * asserting only implicitly via rejection.
   */
  function waitForRejection(socket: WebSocket, timeoutMs = 2000): Promise<'rejected' | 'opened'> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Expected the handshake to be rejected, but it was not')),
        timeoutMs,
      );
      socket.once('error', () => {
        clearTimeout(timer);
        resolve('rejected');
      });
      socket.once('open', () => {
        clearTimeout(timer);
        resolve('opened');
      });
    });
  }

  it('rejects a /ws handshake whose Origin is not this dashboard (CSWSH from any other page)', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`, { origin: 'http://evil.example.com' });
    sockets = [socket];

    await expect(waitForRejection(socket)).resolves.toBe('rejected');
  });

  it('rejects a /ws handshake whose Origin matches this dashboard’s host but the wrong port', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`, {
      origin: `http://localhost:${handle.port + 1}`,
    });
    sockets = [socket];

    await expect(waitForRejection(socket)).resolves.toBe('rejected');
  });

  it('rejects a /ws handshake whose Origin uses a non-http(s) scheme, even with an otherwise-allowed hostname', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    // `new URL('chrome-extension://localhost')` parses to hostname
    // `localhost`, port `''` — without an explicit protocol check, the "no
    // explicit port" branch would compute a default port for it as though
    // it were plain http (any non-`https:` protocol → 80), so this could be
    // accepted purely by coincidence if the dashboard ever happened to bind
    // to port 80. This dashboard only ever serves http(s); fail closed for
    // every other scheme regardless of hostname/port.
    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`, { origin: 'chrome-extension://localhost' });
    sockets = [socket];

    await expect(waitForRejection(socket)).resolves.toBe('rejected');
  });

  it('accepts a /ws handshake with no Origin header at all (non-browser clients)', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    // The `ws` client sends no `Origin` header unless one is explicitly
    // passed — this is exactly what every other test file in this
    // directory already relies on, so this pins that down as intentional
    // rather than incidental.
    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`);
    sockets = [socket];

    const backlog = await waitForMessage(socket, (m) => m.type === 'backlog');
    expect(backlog.type).toBe('backlog');
  });

  it('accepts a /ws handshake whose Origin matches this dashboard’s own localhost URL', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`, { origin: `http://localhost:${handle.port}` });
    sockets = [socket];

    const backlog = await waitForMessage(socket, (m) => m.type === 'backlog');
    expect(backlog.type).toBe('backlog');
  });

  it('accepts a /ws handshake whose Origin is the 127.0.0.1 form of this dashboard', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    // Connects via `localhost` (see the describe block's own doc comment)
    // while claiming an `Origin` of `127.0.0.1` — exercises that hostname
    // being on the allowlist without depending on this dashboard (bound to
    // whatever `localhost` itself resolves to) actually being reachable at
    // the literal address `127.0.0.1` in this environment.
    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`, {
      origin: `http://127.0.0.1:${handle.port}`,
    });
    sockets = [socket];

    const backlog = await waitForMessage(socket, (m) => m.type === 'backlog');
    expect(backlog.type).toBe('backlog');
  });

  it('accepts a LAN-address Origin only once --lan (host: "0.0.0.0") is actually in effect', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0, host: '0.0.0.0', lanAddresses: [FAKE_LAN_ADDRESS] }, eventBus);
    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`, {
      origin: `http://${FAKE_LAN_ADDRESS}:${handle.port}`,
    });
    sockets = [socket];

    const backlog = await waitForMessage(socket, (m) => m.type === 'backlog');
    expect(backlog.type).toBe('backlog');
  });

  it('rejects a LAN-address Origin when this dashboard is still localhost-only (--lan not in effect)', async () => {
    const eventBus = new DetourEventBus();
    // `lanAddresses` broadcast for display purposes (see
    // `dashboardServer.lanInfo.test.ts`) doesn't by itself make this
    // dashboard reachable there — it's still bound to loopback only, so an
    // Origin claiming one of those addresses must still be rejected.
    handle = await startDashboardServer({ port: 0, lanAddresses: [FAKE_LAN_ADDRESS] }, eventBus);
    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`, {
      origin: `http://${FAKE_LAN_ADDRESS}:${handle.port}`,
    });
    sockets = [socket];

    await expect(waitForRejection(socket)).resolves.toBe('rejected');
  });

  it('rejects a /ws handshake with a DNS-rebound Host header naming a foreign domain', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    // Simulates a DNS-rebinding attack: the TCP connection lands on this
    // dashboard, but the `Host` header still names the attacker's domain —
    // no `Origin` header at all here, so this pins down that `Host` is
    // checked independently rather than only as a fallback when `Origin`
    // is present.
    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`, { headers: { host: 'evil.example.com' } });
    sockets = [socket];

    await expect(waitForRejection(socket)).resolves.toBe('rejected');
  });

  it.each([
    ['a DNS-rebound Host header naming a foreign domain', 'evil.example.com'],
    [
      // `::1:1234` has two colons outside of brackets. A naive "split on the
      // last colon" parse would read this as hostname `::1` (allowed) with
      // port `1234`, bypassing the allowlist. RFC 7230 requires IPv6
      // literals in a Host header to be bracketed, so this must be rejected
      // outright.
      'an unbracketed IPv6-looking Host header',
      // eslint-disable-next-line sonarjs/no-hardcoded-ip -- loopback address used as a malformed Host header fixture, not a real address.
      '::1:1234',
    ],
    [
      // `localhost:evil` has exactly one `:`, same as a legitimate
      // `host:port` — a parse that only checks colon count (and not that
      // what follows is actually a port) would slice this down to
      // `localhost` and let it through, defeating the allowlist by accident.
      'a Host header whose port is non-numeric',
      'localhost:evil',
    ],
    [
      // Same concern as 'localhost:evil' above, but for the bracketed IPv6
      // form: whatever follows the closing `]` must be empty or `:<digits>`,
      // not just accepted because the bracket itself parsed cleanly.
      'a bracketed IPv6 Host header whose port is non-numeric',
      // eslint-disable-next-line sonarjs/no-hardcoded-ip -- loopback address used as a malformed Host header fixture, not a real address.
      '[::1]:evil',
    ],
  ])('rejects a static asset request with %s', async (_description, hostHeaderValue) => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(
        { host: 'localhost', port: handle?.port, path: '/', headers: { Host: hostHeaderValue } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(403);
  });

  it('serves a static asset request with a legitimate Host header normally', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request({ host: 'localhost', port: handle?.port, path: '/' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });

    // Not 403 — whatever `serveStatic` itself would have returned (200, or
    // 404/500 when the dashboard build isn't present in this test
    // environment) now that the Host allowlist has let the request through.
    expect(status).not.toBe(403);
  });
});

/**
 * Covers `computeAllowedHostnames` directly (issue #92 follow-up): a Copilot
 * review on the original allowlist found that binding to a single explicit
 * non-loopback interface address — a supported case per
 * `DashboardServerOptions.host`'s doc comment — would 403 every request,
 * since neither `dashboardOnLan` nor the loopback names cover it. Pure-logic
 * unit tests here, rather than an integration test that actually binds to
 * such an address, since a real LAN/arbitrary interface address isn't
 * something CI can be relied on to have.
 */
describe('computeAllowedHostnames (issue #92 follow-up)', () => {
  it('allows an explicit non-loopback bind address even though it is neither localhost nor 0.0.0.0', () => {
    const allowed = computeAllowedHostnames(FAKE_LAN_ADDRESS, false, []);
    expect(allowed).toContain(FAKE_LAN_ADDRESS);
    expect(allowed).toContain('localhost');
  });

  it('still allows the loopback names for the default localhost bind', () => {
    const allowed = computeAllowedHostnames('localhost', false, []);
    expect(allowed).toEqual(['localhost', '127.0.0.1', '::1', 'localhost']);
  });

  it('includes LAN addresses only when dashboardOnLan (bound to 0.0.0.0)', () => {
    const allowed = computeAllowedHostnames('0.0.0.0', true, [FAKE_LAN_ADDRESS]);
    expect(allowed).toContain(FAKE_LAN_ADDRESS);
    expect(allowed).toContain('0.0.0.0');
  });

  it('omits LAN addresses when not bound to every interface', () => {
    const allowed = computeAllowedHostnames('localhost', false, [FAKE_LAN_ADDRESS]);
    expect(allowed).not.toContain(FAKE_LAN_ADDRESS);
  });

  it('lower-cases the bind host so a mixed-case value still matches a lower-cased Host header', () => {
    const allowed = computeAllowedHostnames('MyHost.Local', false, []);
    expect(allowed).toContain('myhost.local');
  });
});
