import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
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
   * as `lanInfo` (issue #66's sidebar LAN Access section) — pass `[]` (the
   * default) or omit when `host` is `localhost`-only. Computed by the
   * caller (`cli.ts`, via `lanAddresses()`) rather than here so this module
   * doesn't need its own opinion on which `host` values count as "LAN",
   * mirroring how `proxyPort` above is also the caller's own value handed
   * through rather than derived.
   */
  lanAddresses?: string[];
}

export interface DashboardServerHandle {
  /** Port the dashboard actually bound to (relevant when options.port is 0). */
  port: number;
  stop(): Promise<void>;
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

  const httpServer = http.createServer((req, res) => serveStatic(WEB_DIST_DIR, req, res));
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // Issue #66's optional dashboard password: sockets that have proven they
  // know the current password (or connected while none was configured — see
  // `wss.on('connection', ...)` below) live in this set. A `WeakSet` rather
  // than a plain property on the socket so nothing here needs to remember to
  // clean up on close — an unreachable socket just falls out of it.
  const authenticatedSockets = new WeakSet<WebSocket>();
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
      if (client.readyState === client.OPEN && authenticatedSockets.has(client)) client.send(payload);
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
    data: ruleEngine ? { rules: [...ruleEngine.getRules()] } : null,
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
        dashboardPasswordSet: !!config.dashboardPasswordHash,
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
    const lanInfoMessage: DashboardServerMessage = { type: 'lanInfo', addresses: lanAddrs };
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
          if (message.type === 'login') {
            const hash = currentPasswordHash();
            if (!hash || (await verifyDashboardPassword(message.password, hash))) {
              authenticatedSockets.add(socket);
              sendInitialPayload(socket);
            } else {
              const authFailedMessage: DashboardServerMessage = { type: 'authFailed' };
              socket.send(JSON.stringify(authFailedMessage));
            }
          }
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

  function handleRulesMessage(message: DashboardClientMessage): void {
    if (message.type === 'setRules') {
      if (!ruleEngine) return broadcastError('RULES_WRITE_ERROR', 'No rules file is configured for this session.');
      try {
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
        ruleProfileStore.write(message.name, { rules: [...ruleEngine.getRules()] });
        broadcast(ruleProfilesMessage());
      } catch (err) {
        broadcastError('RULE_PROFILE_ERROR', describeError(err));
      }
    } else if (message.type === 'applyRuleProfile') {
      if (!ruleEngine || !ruleProfileStore)
        return broadcastError('RULE_PROFILE_ERROR', 'Rule profiles are unavailable.');
      try {
        ruleEngine.write(ruleProfileStore.read(message.name).rules);
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
      const boundPort = typeof address === 'object' && address ? address.port : options.port;
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
