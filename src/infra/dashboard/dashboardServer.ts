import http from 'node:http';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import type {
  BlockHostsState,
  CapturedExchange,
  CapturedWebSocketConnection,
  DetourEvents,
  FocusState,
  InterceptState,
  ThrottleState,
} from '../../domain/exchange/types';
import { SAMPLE_RULES_FILE } from '../../domain/rules/sample';
import type { RulesFile } from '../../domain/rules/types';
import { RingBuffer } from '../../domain/shared/ringBuffer';
import type { DashboardClientMessage, DashboardServerMessage } from '../../domain/dashboard/protocol';
import type { HttpRequester } from '../../usecase/ports/httpRequester';
import type { RuleProfileStore } from '../../usecase/ports/ruleProfileStore';
import { replayExchange } from '../../usecase/replayExchange';
import type { RuleEngine } from '../../usecase/ruleEngine';
import type { DetourEventBus } from '../eventBus';
import { loadUserConfig, writeUserConfig } from '../fs/userConfigStore';
import { assertPortAvailable } from '../portCheck';
import { nodeHttpRequester } from '../proxy/nodeHttpRequester';
import { hashDashboardPassword, verifyDashboardPassword } from './dashboardPasswordHash';
import { serveStatic } from './staticServer';

/**
 * How many recent exchanges are kept around to replay to a browser tab that
 * connects (or reconnects) mid-session. Bounded so a long-running `detour
 * start` can't grow this without limit — old entries are simply dropped once
 * a client has already seen them go by live.
 */
const DEFAULT_BACKLOG_SIZE = 500;

// Built dashboard SPA (see web/), copied here as `web-dist/` by `npm run
// build`. Three directories up from this file in both dev (src/infra/dashboard
// → repo root) and prod (dist/infra/dashboard → package root) layouts —
// `tsconfig.json`'s `rootDir: "src"`/`outDir: "dist"` mirror this file's
// nesting exactly, so the same relative path resolves correctly under both
// `tsx src/cli.ts` and the compiled `dist/cli.js`. (Was two levels up before
// the Clean Architecture move from `src/dashboard/` to `src/infra/dashboard/`
// — issue #29 — which added a nesting level here without updating this path,
// making `detour start` unable to find a build that genuinely exists.)
//
// `DETOUR_WEB_DIST_DIR` overrides this for the single-file release bundle
// (issue #52 — esbuild flattens this module into one file, so `__dirname` no
// longer sits three levels below the package root; the bin shim that ships
// with the release tarball sets this env var instead of relying on depth).
export const WEB_DIST_DIR = process.env.DETOUR_WEB_DIST_DIR
  ? path.resolve(process.env.DETOUR_WEB_DIST_DIR)
  : path.resolve(__dirname, '..', '..', '..', 'web-dist');

export interface DashboardServerOptions {
  port: number;
  host?: string;
  /**
   * The proxy's own port, broadcast to clients as `proxyInfo` (issue #24's
   * sidebar Proxy URL / QR code). Optional so tests that only care about the
   * dashboard itself don't need to fabricate one.
   */
  proxyPort?: number;
  /** @default 500 */
  backlogSize?: number;
  /**
   * The session's rule engine, if `detour start` was given `--rules` (or
   * auto-detected one) — powers the Rules editor (issue #19): reading the
   * active ruleset for `rules`/`setRules`, and saving edits back via
   * `RuleEngine.write()`. Omitted (dashboard-only, no proxy rules) when
   * this session has no rules file configured.
   */
  ruleEngine?: RuleEngine;
  /** Powers Rules Profiles (issue #19): listing/creating/applying saved rule profiles, independent of whether `ruleEngine` is configured (profiles can be created even before any is applied). */
  ruleProfileStore?: RuleProfileStore;
  /** Performs the real outbound request for `replay` (issue #19). Injectable for tests; defaults to a real `node:http`/`node:https` request. */
  httpRequester?: HttpRequester;
  /** Backs `userConfig`/`setUserConfig` (the dashboard Settings panel's `defaultDetach`/`lanAccess` toggles). Injectable for tests; defaults to `~/.detour/config.json` (`resolveUserConfigPath()`). */
  userConfigPath?: string;
  /**
   * Every non-internal IPv4 address this machine has, broadcast to clients
   * as `lanInfo` (issue #66's sidebar LAN Access section) — the caller
   * (`cli.ts`) passes this regardless of this server's own `host`, since
   * the proxy it's fronting always binds to every interface either way
   * (see cli.ts's `PROXY_HOST`) and its LAN address(es) are worth showing
   * on that basis alone. Pass `[]` (the default) or omit only when this
   * machine genuinely has none to offer. Computed by the caller rather
   * than here so this module doesn't need its own opinion on which
   * addresses count as "LAN", mirroring how `proxyPort` above is also the
   * caller's own value handed through rather than derived. Contrast
   * `sendInitialPayload`'s own `dashboardOnLan`, which *is* derived from
   * this server's own `host` — that one bit genuinely is this module's to
   * know.
   */
  lanAddresses?: string[];
}

export interface DashboardServerHandle {
  /** Port the dashboard actually bound to (relevant when options.port is 0). */
  port: number;
  stop(): Promise<void>;
}

/**
 * The `Host`/`Origin` hostnames a CSWSH/DNS-rebinding check (issue #92)
 * should accept for a dashboard bound to `host`. Pulled out as pure logic —
 * same reasoning as cli.ts's `resolveDashboardPort`/`shouldAutoOpenDashboard`
 * — so this is testable without actually binding a socket.
 *
 * Always allows `localhost`/`127.0.0.1`/`::1`, plus this machine's own LAN
 * address(es) (`lanAddrs`) only when `dashboardOnLan` — matching exactly
 * what the server is actually bound to and thus reachable at.
 *
 * `host` itself (lower-cased) is also always allowed: `options.host` is a
 * plain `string` (see `DashboardServerOptions.host`'s doc comment and
 * `sendInitialPayload`'s own `dashboardOnLan` comment), so a caller can bind
 * to a single explicit non-loopback interface address (`192.168.1.5`, say)
 * rather than only `localhost`/`0.0.0.0` — `dashboardOnLan` is then `false`
 * (it's neither), yet a legitimate client's `Host`/`Origin` will still name
 * that address specifically, since it's the only interface the bind
 * actually accepts connections on. Without this, every request against
 * such a bind would 403.
 */
export function computeAllowedHostnames(
  host: string,
  dashboardOnLan: boolean,
  lanAddrs: readonly string[],
): readonly string[] {
  const base = ['localhost', '127.0.0.1', '::1', host.toLowerCase()];
  return dashboardOnLan ? [...base, ...lanAddrs] : base;
}

/**
 * Serves the built dashboard (static files + a `/ws` WebSocket feed of live
 * traffic) on `options.port`. Every exchange published on the event bus is
 * broadcast to all connected browser tabs in real time; a bounded backlog is
 * replayed to newly-connected clients so refreshing the page doesn't lose
 * recent history.
 */
export async function startDashboardServer(
  options: DashboardServerOptions,
  eventBus: DetourEventBus,
): Promise<DashboardServerHandle> {
  const host = options.host ?? 'localhost';
  const { ruleEngine, ruleProfileStore } = options;
  const httpRequester = options.httpRequester ?? nodeHttpRequester;
  const lanAddrs = options.lanAddresses ?? [];
  // Whether this server itself is bound to every network interface, not
  // just loopback — see `sendInitialPayload`'s own `dashboardOnLan` below,
  // which this mirrors. Only in this case are `lanAddrs` actually reachable
  // at all (a `localhost`-only bind never accepts a connection arriving on
  // a LAN address in the first place), so it's also the gate on whether
  // `isAllowedHost`/`isAllowedOrigin` below treat them as legitimate.
  const dashboardOnLan = host === '0.0.0.0';
  // The dashboard's actual bound port — `options.port` verbatim except for
  // an ephemeral `port: 0`, which only resolves to a real port once
  // `httpServer.listen()`'s callback fires below. `isAllowedOrigin` needs
  // the real value (an `Origin` header's port must match what this server
  // is actually reachable on), so this is declared as a `let` here and
  // updated once listening starts, rather than read fresh via
  // `httpServer.address()` on every handshake.
  let boundPort = options.port;
  await assertPortAvailable(options.port, host);

  const backlog = new RingBuffer<CapturedExchange>(options.backlogSize ?? DEFAULT_BACKLOG_SIZE, (item) => item.id);
  // Mirrors `backlog` above, but for WebSocket connections (issue #17) —
  // kept in its own buffer/message type since a connection's shape (a
  // stream of frames rather than one request/response pair) doesn't fit
  // alongside `CapturedExchange`.
  const wsBacklog = new RingBuffer<CapturedWebSocketConnection>(
    options.backlogSize ?? DEFAULT_BACKLOG_SIZE,
    (item) => item.id,
  );
  // Mirrors the proxy server's own `interceptEnabled` (which is the source
  // of truth) so a newly-connecting client can be told the current state
  // without a round trip — kept in sync via the `interceptChanged` event,
  // the same way `backlog` mirrors traffic.
  let interceptState: InterceptState = { enabled: true };
  // Mirrors the proxy server's own `focusHosts` the same way, kept in sync
  // via `focusChanged`.
  let focusState: FocusState = { hosts: [] };
  // Mirrors the proxy server's own `throttleState` the same way, kept in
  // sync via `throttleChanged`.
  let throttleState: ThrottleState = { enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0, packetLossPct: 0 };
  // Mirrors the proxy server's own `blockHostsState` the same way, kept in
  // sync via `blockHostsChanged`.
  let blockHostsState: BlockHostsState = { hosts: [], mode: 'forbidden' };

  // CSWSH / DNS-rebinding defenses (issue #92). A WebSocket handshake isn't
  // subject to the browser's same-origin policy the way `fetch`/XHR are, so
  // without these, any web page on any origin — not just ones served from
  // this machine — could open `ws://localhost:<dashboardPort>/ws` and:
  // eavesdrop on the decrypted-HTTPS backlog it streams (Authorization
  // headers, cookies, ...), rewrite `rules.json` via `setRules` to reroute
  // traffic, SSRF via `replay`, or lock the real user out via
  // `setDashboardPassword`. `--dashboard-password` (issue #66) doesn't help
  // here either — most sessions never set one, and even the handshake
  // itself (before any message is sent) already leaks the backlog once
  // `sendInitialPayload` fires. The dashboard's own port is also easily
  // guessable (`--port + 1000`, or just tried), so "an attacker doesn't
  // know the port" isn't a defense on its own.
  //
  //   - `isAllowedHost` guards both the static SPA and `/ws`: it checks the
  //     `Host` header a *DNS-rebound* page would send (an attacker-owned
  //     domain that a malicious DNS response points at 127.0.0.1) — that
  //     header still names the attacker's domain regardless of which IP the
  //     TCP connection actually landed on, so this catches what `Origin`
  //     alone can't (a request that's missing `Origin` entirely still
  //     carries `Host`).
  //   - `isAllowedOrigin` guards `/ws` specifically: it checks the `Origin`
  //     header a browser attaches to a cross-origin fetch/handshake, which
  //     `Host` alone can't catch (a same-machine-hosted attacker page has a
  //     legitimate `Host: localhost:<dashboardPort>` but a foreign
  //     `Origin`). Absent entirely (no browser involved — a native app, or
  //     the `ws` client library used by this file's own tests, which sends
  //     none by default) is allowed through: there's no origin-confusion
  //     risk to check when nothing claims an origin at all.
  //
  // See `computeAllowedHostnames`'s doc comment for what this allows and why.
  function allowedHostnames(): readonly string[] {
    return computeAllowedHostnames(host, dashboardOnLan, lanAddrs);
  }

  // Extracts the hostname portion of a `Host` header (`localhost:5173` →
  // `localhost`, `[::1]:5173` → `::1`), lower-cased for a case-insensitive
  // compare against `allowedHostnames()`. `undefined` for a missing header
  // (HTTP/1.1 requires one; node's own parser already rejects a request
  // without one before this ever runs, but there's no reason to trust that
  // remaining true forever) or an unparseable IPv6-bracket form.
  function hostnameOf(hostHeader: string | undefined): string | undefined {
    if (!hostHeader) return undefined;
    if (hostHeader.startsWith('[')) {
      const end = hostHeader.indexOf(']');
      return end === -1 ? undefined : hostHeader.slice(1, end).toLowerCase();
    }
    const firstColon = hostHeader.indexOf(':');
    const lastColon = hostHeader.lastIndexOf(':');
    // More than one `:` outside of brackets means this isn't `host` or
    // `host:port` — it's an unbracketed IPv6 literal (e.g. `::1:1234`),
    // which RFC 7230 doesn't permit as a bare Host value. Reject rather than
    // guess which segment is the "hostname", so a malformed/ambiguous Host
    // header can't be parsed into something that happens to match the
    // allowlist.
    if (firstColon !== -1 && firstColon !== lastColon) return undefined;
    return (lastColon === -1 ? hostHeader : hostHeader.slice(0, lastColon)).toLowerCase();
  }

  function isAllowedHost(hostHeader: string | undefined): boolean {
    const hostname = hostnameOf(hostHeader);
    return hostname !== undefined && allowedHostnames().includes(hostname);
  }

  function isAllowedOrigin(originHeader: string | undefined): boolean {
    if (!originHeader) return true;
    let origin: URL;
    try {
      origin = new URL(originHeader);
    } catch {
      // An `Origin` header that isn't even a valid URL can't be a
      // legitimate browser-sent one — fail closed rather than risk treating
      // it as absent.
      return false;
    }
    if (!allowedHostnames().includes(origin.hostname)) return false;
    if (origin.port !== '') return Number(origin.port) === boundPort;
    const defaultPort = origin.protocol === 'https:' ? 443 : 80;
    return defaultPort === boundPort;
  }

  const httpServer = http.createServer((req, res) => {
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    serveStatic(WEB_DIST_DIR, req, res);
  });
  const verifyClient: WebSocket.VerifyClientCallbackSync = (info) =>
    isAllowedHost(info.req.headers.host) && isAllowedOrigin(info.origin);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', verifyClient });

  // Issue #66's optional dashboard password: sockets that have proven they
  // know the current password (or connected while none was configured — see
  // `wss.on('connection', ...)` below) live in this set. A `WeakSet` rather
  // than a plain property on the socket so nothing here needs to remember to
  // clean up on close — an unreachable socket just falls out of it.
  const authenticatedSockets = new WeakSet<WebSocket>();
  // Sockets with a `login` currently awaiting `verifyDashboardPassword` —
  // guards against two `login` frames racing each other: both would pass
  // the `!authenticatedSockets.has(socket)` check below before either
  // resolves, and depending on which `await` settles second, that one could
  // send `authFailed` after the socket was already authenticated by the
  // first, or duplicate the initial snapshot. A `login` that arrives while
  // one's already in flight for that socket is dropped rather than queued —
  // a real client only ever has one outstanding attempt at a time.
  const loginInFlight = new WeakSet<WebSocket>();
  // Read fresh on every check (connect, login attempt, `setDashboardPassword`)
  // rather than cached once at startup — same "no other writer to stay in
  // sync with, so just read the file" reasoning as `userConfigMessage`
  // below, and it's what lets a password set via the Settings panel or
  // `detour config` start applying to new connections without a restart.
  //
  // On a read failure (invalid JSON, a validation failure — same cases
  // `userConfigMessage` below falls back to defaults for), this returns the
  // last value a *successful* read actually produced, rather than `null`:
  // `null` means "no password configured" everywhere it's checked below, so
  // falling back to it unconditionally on error would fail *open* — waving
  // every new connection straight through the moment `~/.detour/config.json`
  // gets corrupted while a password happens to be set (a hand-edit of some
  // unrelated field is enough; `loadUserConfig` fails the whole file, not
  // just the bad key). Falling back to the last-known value instead keeps a
  // real password honored across a transient corruption, while a config
  // that never had one to begin with — most read failures, and every one of
  // them before the very first successful read — still resolves to `null`
  // exactly as before, matching `userConfigMessage`'s own "don't lock
  // anything up over a broken config" posture for every other field.
  let lastKnownPasswordHash: string | null = null;
  const currentPasswordHash = (): string | null => {
    try {
      lastKnownPasswordHash = loadUserConfig(options.userConfigPath).dashboardPasswordHash ?? null;
    } catch {
      // Keep `lastKnownPasswordHash` as it was — see the doc comment above.
    }
    return lastKnownPasswordHash;
  };

  const broadcast = (message: DashboardServerMessage) => {
    const payload = JSON.stringify(message);
    for (const client of wss.clients) {
      // Skips a socket still waiting on `authRequired` — the whole point of
      // gating it is that it never sees live traffic, rule contents, or any
      // other state until it's proven it knows the password.
      if (client.readyState === WebSocket.OPEN && authenticatedSockets.has(client)) client.send(payload);
    }
  };

  const onRequest = (exchange: Readonly<CapturedExchange>) => {
    backlog.upsert(exchange);
    broadcast({ type: 'request', exchange });
  };
  const onResponse = (exchange: Readonly<CapturedExchange>) => {
    backlog.upsert(exchange);
    broadcast({ type: 'response', exchange });
  };
  const onError: DetourEvents['error'] = (event) => broadcast({ type: 'error', event });
  // Rules state, unlike intercept/focus/throttle/blockHosts above, isn't
  // mirrored into a local variable kept in sync via events — `ruleEngine`
  // (if configured) is already the live source of truth, so these just read
  // through it on demand, both for a newly-connecting client and for
  // rebroadcasting after any reload.
  const rulesMessage = (): DashboardServerMessage => ({
    type: 'rules',
    data: ruleEngine ? { rules: [...ruleEngine.getRules()], $activeProfile: ruleEngine.getActiveProfile() } : null,
  });
  const ruleProfilesMessage = (): DashboardServerMessage => ({
    type: 'ruleProfiles',
    profiles: ruleProfileStore?.list() ?? [],
  });
  // Unlike rules/ruleProfiles above, this reads straight off disk on every
  // call rather than through an in-memory mirror kept in sync by an event —
  // `~/.detour/config.json` is small, read once per connect/change, and has
  // no other writer this process needs to stay in sync with (contrast
  // `ruleEngine`, which a hand-edited rules.json can also change).
  const userConfigMessage = (): DashboardServerMessage => {
    // Unlike `rulesMessage`/`ruleProfilesMessage` above, this reads a file
    // that can fail validation (a hand-edited `~/.detour/config.json` with a
    // typo'd value) — every other message sent right after connecting is a
    // pure in-memory read that can't throw, and this one running inside
    // `wss.on('connection', ...)` uncaught would crash that connection
    // attempt (or worse) instead of just this one feature. Fall back to
    // defaults; `setUserConfig` below still reports a clear
    // `USER_CONFIG_WRITE_ERROR` (and refuses to write) if a client tries to
    // change something while the file's in this state.
    let config: ReturnType<typeof loadUserConfig>;
    try {
      config = loadUserConfig(options.userConfigPath);
    } catch {
      config = {};
    }
    return {
      type: 'userConfig',
      state: {
        defaultDetach: config.defaultDetach ?? false,
        lanAccess: config.lanAccess ?? false,
        // `currentPasswordHash()` (not `config.dashboardPasswordHash` read
        // above) — they can disagree the moment the config becomes
        // unreadable after a password was already set: `config` here just
        // fell back to `{}` (so `dashboardPasswordHash` reads as
        // `undefined`), but `currentPasswordHash()` fails *closed* to the
        // last successfully-read hash instead (see its own doc comment).
        // Deriving this from the same fail-closed-aware getter that
        // `login`/connection-gating actually uses keeps what a client is
        // told in sync with whether a password is genuinely still required.
        dashboardPasswordSet: !!currentPasswordHash(),
      },
    };
  };
  const broadcastError = (errorKind: string, message: string) =>
    broadcast({ type: 'error', event: { errorKind, message } });
  // Fires after *any* rules.json reload — whether triggered by `setRules`/
  // `applyRuleProfile` (which write the file, then wait for the same
  // fs.watch-driven reload a hand-edit would trigger) or an actual hand-edit
  // in a text editor. `rulesMessage()` itself only ever produces a non-null
  // `data` once a `ruleEngine` exists to emit this event in the first place,
  // so registering the listener unconditionally (like every other listener
  // in this function) is harmless when there isn't one.
  const onRulesReloaded: DetourEvents['rulesReloaded'] = () => broadcast(rulesMessage());
  // A `breakpoint` rule paused an exchange — broadcast it to every connected
  // tab so all of them can show/edit it, not just the one that happens to be
  // focused.
  const onBreakpointHit: DetourEvents['breakpointHit'] = ({ exchange, payload }) =>
    broadcast({ type: 'breakpoint', exchange, payload });
  const onInterceptChanged: DetourEvents['interceptChanged'] = (state) => {
    interceptState = state;
    broadcast({ type: 'intercept', state });
  };
  const onFocusChanged: DetourEvents['focusChanged'] = (state) => {
    focusState = state;
    broadcast({ type: 'focus', state });
  };
  const onThrottleChanged: DetourEvents['throttleChanged'] = (state) => {
    throttleState = state;
    broadcast({ type: 'throttle', state });
  };
  const onBlockHostsChanged: DetourEvents['blockHostsChanged'] = (state) => {
    blockHostsState = state;
    broadcast({ type: 'blockHosts', state });
  };
  const onWsOpen: DetourEvents['wsOpen'] = (connection) => {
    wsBacklog.upsert(connection);
    broadcast({ type: 'wsOpen', connection });
  };
  const onWsFrame: DetourEvents['wsFrame'] = (connection) => {
    wsBacklog.upsert(connection);
    broadcast({ type: 'wsFrame', connection });
  };
  const onWsClose: DetourEvents['wsClose'] = (connection) => {
    wsBacklog.upsert(connection);
    broadcast({ type: 'wsClose', connection });
  };

  // The full just-connected snapshot — sent immediately to a socket that
  // needed no password, or once one that did has proven it via `login`.
  // Order matches the pre-issue-#66 unconditional sends exactly (no test or
  // client relies on it, but no reason to shuffle it either).
  const sendInitialPayload = (socket: WebSocket) => {
    if (options.proxyPort !== undefined) {
      const proxyInfoMessage: DashboardServerMessage = { type: 'proxyInfo', proxyPort: options.proxyPort };
      socket.send(JSON.stringify(proxyInfoMessage));
    }
    const lanInfoMessage: DashboardServerMessage = {
      type: 'lanInfo',
      addresses: lanAddrs,
      // Specifically `=== '0.0.0.0'`, not merely `!== 'localhost'`: `host`
      // is a plain `string` (see `DashboardServerOptions.host`), so it's
      // never guaranteed to be one of only those two values — a caller
      // could hand this a single bare interface address (`192.168.1.5`,
      // say) to bind just that one NIC. `!== 'localhost'` would call that
      // "on every interface" too, sending clients a Dashboard URL for
      // every *other* LAN address this machine has, none of which that
      // bind would actually accept a connection on.
      dashboardOnLan: host === '0.0.0.0',
    };
    socket.send(JSON.stringify(lanInfoMessage));
    const backlogMessage: DashboardServerMessage = { type: 'backlog', items: backlog.toArray() };
    socket.send(JSON.stringify(backlogMessage));
    const wsBacklogMessage: DashboardServerMessage = { type: 'wsBacklog', items: wsBacklog.toArray() };
    socket.send(JSON.stringify(wsBacklogMessage));
    const interceptMessage: DashboardServerMessage = { type: 'intercept', state: interceptState };
    socket.send(JSON.stringify(interceptMessage));
    const focusMessage: DashboardServerMessage = { type: 'focus', state: focusState };
    socket.send(JSON.stringify(focusMessage));
    const throttleMessage: DashboardServerMessage = { type: 'throttle', state: throttleState };
    socket.send(JSON.stringify(throttleMessage));
    const blockHostsMessage: DashboardServerMessage = { type: 'blockHosts', state: blockHostsState };
    socket.send(JSON.stringify(blockHostsMessage));
    socket.send(JSON.stringify(rulesMessage()));
    socket.send(JSON.stringify(ruleProfilesMessage()));
    socket.send(JSON.stringify(userConfigMessage()));
  };

  wss.on('connection', (socket: WebSocket) => {
    // No password configured: grandfather this socket in permanently, even
    // if a password gets set later while it's still open — same "changing
    // the Wi-Fi password doesn't kick already-connected devices" posture as
    // `--lan`'s own bind-at-spawn-time semantics. Only *new* connections
    // made after that point are asked for it.
    if (!currentPasswordHash()) authenticatedSockets.add(socket);

    if (authenticatedSockets.has(socket)) {
      sendInitialPayload(socket);
    } else {
      const authRequiredMessage: DashboardServerMessage = { type: 'authRequired' };
      socket.send(JSON.stringify(authRequiredMessage));
    }

    // The only browser → server traffic on this socket: resuming/aborting a
    // paused breakpoint, toggling intercept on/off, editing the Focus host
    // allowlist, editing the Throttle profile, and editing the Block Hosts
    // denylist. All are relayed onto the event bus, where the proxy server
    // is waiting on them (see proxyServer.ts's
    // `waitForBreakpoint`/`handleSetIntercept`/`handleSetFocus`/`handleSetThrottle`/`handleSetBlockHosts`).
    // Rules editing/profiles (issue #19) are the one exception: handled
    // directly here rather than via the event bus, since they need
    // synchronous validation and per-attempt error feedback that a fire-and-
    // forget event emit can't give — see `handleRulesMessage` below.
    // `async`, not sync: `verifyDashboardPassword`/`hashDashboardPassword`
    // below are async precisely so scrypt's work runs off the main thread
    // (see `dashboardPasswordHash.ts`) — awaiting them here is what actually
    // gets that benefit, rather than serializing right back onto this
    // handler anyway. `ws` doesn't care that the listener returns a promise;
    // nothing here needs the caller to wait on it.
    socket.on('message', async (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as DashboardClientMessage;

        if (!authenticatedSockets.has(socket)) {
          // Nothing but `login` is honored before authenticating — a
          // malicious device on the network that skipped straight to
          // `setRules`/`replay`/etc. without ever proving it knows the
          // password gets silently ignored, same as a malformed frame.
          if (message.type === 'login') await handleLoginMessage(socket, message);
          return;
        }

        if (message.type === 'breakpointResume') eventBus.emit('breakpointResume', message.command);
        else if (message.type === 'setIntercept') eventBus.emit('setIntercept', message.enabled);
        else if (message.type === 'setFocus') eventBus.emit('setFocus', message.hosts);
        else if (message.type === 'setThrottle') eventBus.emit('setThrottle', message.state);
        else if (message.type === 'setBlockHosts') eventBus.emit('setBlockHosts', message.state);
        else if (message.type === 'replay') {
          // Fire-and-forget: `replayExchange` never rejects (network
          // failures land in the replayed exchange's own `error` field, see
          // its doc comment) — this catch only guards against a genuine bug.
          void replayExchange(message.exchange, eventBus, httpRequester).catch((err) =>
            broadcastError('REPLAY_ERROR', describeError(err)),
          );
        } else if (message.type === 'setUserConfig') {
          try {
            writeUserConfig(message.state, options.userConfigPath);
            broadcast(userConfigMessage());
          } catch (err) {
            broadcastError('USER_CONFIG_WRITE_ERROR', describeError(err));
          }
        } else if (message.type === 'setDashboardPassword') {
          try {
            if (message.password === '') {
              // Silently accepting this would set a real, trivially-guessable
              // password while `dashboardPasswordSet` reports "on" — worse
              // than not setting one at all, since it looks protected.
              throw new Error('Dashboard password must not be empty — pass null to remove it.');
            }
            const dashboardPasswordHash =
              message.password === null ? null : await hashDashboardPassword(message.password);
            writeUserConfig({ dashboardPasswordHash }, options.userConfigPath);
            // Updates `lastKnownPasswordHash` immediately rather than
            // waiting for some future `currentPasswordHash()` call to catch
            // up: without this, a password set here has no effect on
            // `lastKnownPasswordHash`'s fail-closed fallback (see its own
            // doc comment) until the next connect/login attempt happens to
            // read it back successfully — leaving a window, right after
            // setting a password, where the config becoming unreadable
            // before that next read would still fail open.
            lastKnownPasswordHash = dashboardPasswordHash;
            broadcast(userConfigMessage());
          } catch (err) {
            broadcastError('USER_CONFIG_WRITE_ERROR', describeError(err));
          }
        } else handleRulesMessage(message);
      } catch {
        // Ignore malformed frames rather than crashing the dashboard.
      }
    });
  });

  /**
   * Answers a `login` attempt from a not-yet-authenticated socket — pulled
   * out of the `socket.on('message', ...)` handler both for its own sake
   * (that handler was getting long) and to keep `loginInFlight`'s
   * add/try/finally/delete dance visually separate from the message
   * dispatch it's guarding.
   */
  async function handleLoginMessage(
    socket: WebSocket,
    message: Extract<DashboardClientMessage, { type: 'login' }>,
  ): Promise<void> {
    if (loginInFlight.has(socket)) return;
    loginInFlight.add(socket);
    try {
      const hash = currentPasswordHash();
      let verified: boolean;
      try {
        verified = !hash || (await verifyDashboardPassword(message.password, hash));
      } catch {
        // A crypto failure verifying the password is the server's problem,
        // not proof the client is wrong — but it still needs *some*
        // response. The outer `socket.on('message', ...)` handler's own
        // catch would otherwise swallow this silently, stranding the socket
        // locked out with no `authFailed` to prompt a retry.
        verified = false;
      }
      if (verified) {
        authenticatedSockets.add(socket);
        sendInitialPayload(socket);
      } else {
        const authFailedMessage: DashboardServerMessage = { type: 'authFailed' };
        socket.send(JSON.stringify(authFailedMessage));
      }
    } finally {
      loginInFlight.delete(socket);
    }
  }

  function handleRulesMessage(message: DashboardClientMessage): void {
    if (message.type === 'setRules') {
      if (!ruleEngine) return broadcastError('RULES_WRITE_ERROR', 'No rules file is configured for this session.');
      try {
        // No `activeProfile` — clears `$activeProfile` on the written file
        // even if `message.data` (the editor's own draft, synced from an
        // earlier `rules` broadcast) still happened to carry one along.
        // Editing and saving makes this a different, unnamed ruleset,
        // regardless of what it used to match — see
        // `RulesFile.$activeProfile`'s doc comment.
        ruleEngine.write(message.data.rules);
      } catch (err) {
        broadcastError('RULES_WRITE_ERROR', describeError(err));
      }
    } else if (message.type === 'createRuleProfile') {
      if (!ruleProfileStore) return broadcastError('RULE_PROFILE_ERROR', 'Rule profiles are unavailable.');
      try {
        const data: RulesFile =
          message.template === 'sample' ? (JSON.parse(SAMPLE_RULES_FILE) as RulesFile) : { rules: [] };
        ruleProfileStore.write(message.name, data);
        broadcast(ruleProfilesMessage());
      } catch (err) {
        broadcastError('RULE_PROFILE_ERROR', describeError(err));
      }
    } else if (message.type === 'saveActiveRulesAsProfile') {
      if (!ruleEngine || !ruleProfileStore)
        return broadcastError('RULE_PROFILE_ERROR', 'Rule profiles are unavailable.');
      try {
        const rules = [...ruleEngine.getRules()];
        ruleProfileStore.write(message.name, { rules });
        // The active rules.json's *content* doesn't change here — only a
        // new profile file, snapshotting it, does — but that content now
        // does correspond to a named profile where a moment ago it may not
        // have, so this marks it as such (see `RulesFile.$activeProfile`).
        ruleEngine.write(rules, { activeProfile: message.name });
        broadcast(ruleProfilesMessage());
      } catch (err) {
        broadcastError('RULE_PROFILE_ERROR', describeError(err));
      }
    } else if (message.type === 'applyRuleProfile') {
      if (!ruleEngine || !ruleProfileStore)
        return broadcastError('RULE_PROFILE_ERROR', 'Rule profiles are unavailable.');
      try {
        ruleEngine.write(ruleProfileStore.read(message.name).rules, { activeProfile: message.name });
      } catch (err) {
        broadcastError('RULE_PROFILE_ERROR', describeError(err));
      }
    }
  }

  return new Promise((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(options.port, host, () => {
      // Only subscribed once bound: if listen() fails (e.g. a port grabbed by
      // another process in the gap since assertPortAvailable's check), there
      // must be no dangling event-bus listeners left over from this attempt.
      eventBus.on('request', onRequest);
      eventBus.on('response', onResponse);
      eventBus.on('error', onError);
      eventBus.on('breakpointHit', onBreakpointHit);
      eventBus.on('interceptChanged', onInterceptChanged);
      eventBus.on('focusChanged', onFocusChanged);
      eventBus.on('throttleChanged', onThrottleChanged);
      eventBus.on('blockHostsChanged', onBlockHostsChanged);
      eventBus.on('wsOpen', onWsOpen);
      eventBus.on('wsFrame', onWsFrame);
      eventBus.on('wsClose', onWsClose);
      eventBus.on('rulesReloaded', onRulesReloaded);

      const address = httpServer.address();
      // Reassigns the outer `let boundPort` (declared up top, alongside
      // `isAllowedOrigin`'s doc comment on why) — not a new binding — so an
      // ephemeral `port: 0` resolving to a real OS-assigned port here is
      // what `isAllowedOrigin` checks handshakes against from this point on.
      boundPort = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port: boundPort,
        stop: () =>
          new Promise<void>((res) => {
            eventBus.off('request', onRequest);
            eventBus.off('response', onResponse);
            eventBus.off('error', onError);
            eventBus.off('breakpointHit', onBreakpointHit);
            eventBus.off('interceptChanged', onInterceptChanged);
            eventBus.off('focusChanged', onFocusChanged);
            eventBus.off('throttleChanged', onThrottleChanged);
            eventBus.off('blockHostsChanged', onBlockHostsChanged);
            eventBus.off('wsOpen', onWsOpen);
            eventBus.off('wsFrame', onWsFrame);
            eventBus.off('wsClose', onWsClose);
            eventBus.off('rulesReloaded', onRulesReloaded);
            for (const client of wss.clients) client.close();
            wss.close(() => httpServer.close(() => res()));
          }),
      });
    });
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
