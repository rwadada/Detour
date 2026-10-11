import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
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
import { toResponsePatch, toWireExchange } from '../../domain/exchange/wireExchange';
import { RingBuffer } from '../../domain/shared/ringBuffer';
import {
  PROTOCOL_VERSION,
  type DashboardClientMessage,
  type DashboardServerMessage,
} from '../../domain/dashboard/protocol';
import type { HttpRequester } from '../../usecase/ports/httpRequester';
import type { RuleProfileStore } from '../../usecase/ports/ruleProfileStore';
import { replayExchange } from '../../usecase/replayExchange';
import type { RuleEngine } from '../../usecase/ruleEngine';
import type { DetourEventBus } from '../eventBus';
import { loadUserConfig, writeUserConfig } from '../fs/userConfigStore';
import type { ProtoRegistry } from '../grpc/protoRegistry';
import { assertPortAvailable } from '../portCheck';
import type { HistoryStore } from '../persistence/historyStore';
import { nodeHttpRequester } from '../proxy/nodeHttpRequester';
import {
  DASHBOARD_SESSION_COOKIE,
  sessionCookieValue,
  tokenFromUrl,
  tokensEqual,
  urlWithoutToken,
} from '../../domain/auth/dashboardAccess';
import type { UpdateService } from '../../domain/update/updateService';
import { parseClientMessage } from '../../domain/dashboard/clientMessage';
import { createControlDeps } from './controlBridge';
import { startControlServer, type ControlServerHandle } from './controlServer';
import type { AdbReverseWatcher } from '../adb/adbReverseWatcher';
import { createDashboardAdbReverse } from './dashboardAdbReverse';
import { createDashboardAuth } from './dashboardAuth';
import { createMessageHandlers, dispatchMessage } from './dashboardMessageHandlers';
import { createRulesHandlers } from './dashboardRulesHandlers';
import { describeError } from './describeError';
import { createDashboardUpdates } from './dashboardUpdates';
import { serveStatic } from './staticServer';

/**
 * How many recent exchanges are kept around to replay to a browser tab that
 * connects (or reconnects) mid-session. Bounded so a long-running `detour
 * start` can't grow this without limit — old entries are simply dropped once
 * a client has already seen them go by live.
 */
const DEFAULT_BACKLOG_SIZE = 500;

/** How long `stop()` lets connections finish before cutting them (issue #206). */
const SHUTDOWN_DRAIN_MS = 3000;

/**
 * `backlog`'s `RingBuffer.byteLimit.sizeOf` (issue #165): the base64
 * request/response bodies are what actually balloons — 500 exchanges each
 * carrying a couple of 256 KB (pre-base64) bodies is easily a couple
 * hundred MB, well before the 500-item count cap alone would ever evict
 * anything. Headers/URLs/etc. are comparatively negligible and deliberately
 * not counted — this only needs to be a cheap, representative proxy for
 * "how much does this exchange cost to hold onto", not an exact byte count.
 */
function capturedExchangeByteSize(exchange: CapturedExchange): number {
  return (exchange.requestBody?.length ?? 0) + (exchange.responseBody?.length ?? 0);
}

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
  /**
   * The interface to bind to. `cli.ts`'s `resolveDashboardHost` only ever
   * passes `'localhost'` (the default below) or `'0.0.0.0'` (`--lan`), but
   * this is a plain `string` — a caller (a test, or a future option) can
   * hand it a single explicit non-loopback interface address (`192.168.1.5`,
   * say) to bind just that one NIC. `computeAllowedHostnames`'s
   * `dashboardOnLan` check (`host === '0.0.0.0'`) is `false` for such a
   * value, so it's handled by always allowing `host` itself regardless —
   * see that function's doc comment.
   * @default 'localhost'
   */
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
  /**
   * Lazily provisions a `RuleEngine` for a session that started with none
   * (no `--rules`, no auto-detected file) — called at most once, the first
   * time a client actually needs one: switching to a saved profile from a
   * fresh install with nothing active yet (issue #123). Before this existed,
   * `applyRuleProfile` on such a session failed outright with "Rule
   * profiles are unavailable", even for a profile the same session had just
   * created — profile *creation* only ever needed `ruleProfileStore`, so
   * that half of the feature worked while the other silently couldn't
   * follow through. Omit to keep the old behavior (surfacing that error)
   * when this session has nowhere to create a rules file — e.g. a test
   * double with no real filesystem behind it.
   */
  createRuleEngine?: () => RuleEngine;
  /**
   * The session's `--proto` schema, if any (gRPC decoding extended to the
   * dashboard) — its JSON descriptor (`ProtoRegistry.toJSON()`) is sent to
   * every connecting client as `protoSchema`, so the Body tab can decode a
   * gRPC exchange's message frames client-side the same way `--dump full`
   * already does for the CLI. Omitted (dashboard shows raw gRPC bytes,
   * same as no `--proto` at all) when this session has none configured.
   */
  protoRegistry?: ProtoRegistry;
  /**
   * Whether `host:port` is one of this process's own listeners. `replay`
   * (issue #214: its URL is now editable) refuses such a target, the same
   * way the proxy refuses to relay to one (issue #205). Omitted in tests
   * that don't need it: nothing is then refused.
   */
  isSelfTarget?: (host: string, port: number) => Promise<boolean>;
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
  /**
   * The session's `--persist` SQLite store, if any (issue #144's optional
   * persistence beyond the live in-memory backlog) — powers `queryHistory`/
   * `historyResult` and the `historyStatus` sent to every connecting client.
   * Omitted (History feature reports itself disabled) when this session
   * wasn't started with `--persist`.
   */
  historyStore?: HistoryStore;
  /**
   * Serves the dashboard over HTTPS using this `{key, cert}` PEM pair
   * instead of plain HTTP (issue #159) — its SAN should carry every LAN
   * address this server might be reached at (see `CertAuthority`'s
   * `getMultiHostKeyCert`), since a browser could connect via any of them.
   * Appropriate once `--lan` exposes the dashboard to the network: without
   * it, the `login` message (and the password inside it) — and everything
   * sent afterwards, the full decrypted-HTTPS backlog included — crosses
   * the wire in the clear to anyone who can see the traffic. Omit for plain
   * HTTP (the default), matching a `localhost`-only bind where TLS buys
   * nothing over loopback.
   */
  tlsKeyCert?: { key: string; cert: string };
  /**
   * The dashboard's access token (issue #205). When set, and no dashboard
   * password is configured, a client must present it — as the `?token=` of a
   * first visit (traded for an HttpOnly cookie) or on the WebSocket URL —
   * before it is sent any data or may do anything. With a password
   * configured the password is the secret instead and this is not consulted.
   * Omit to leave the dashboard open (what the unit tests do); `detour start`
   * always supplies one.
   */
  accessToken?: string;
  /**
   * Port for the control API (issue #212) — a small REST interface a test
   * runner uses to drive this running Detour (see `controlServer.ts`). Off
   * when omitted. Bound to `127.0.0.1`, and every request needs the access
   * token as a bearer token, so `accessToken` must be set with it. `0` picks
   * a free port; the handle reports it.
   */
  controlPort?: number;
  /** Reported by the control API's `GET /health`. */
  version?: string;
  /**
   * Whether this session was started with `--insecure-upstream` (issue
   * #160) — sent to every connecting client as `proxyInfo`'s own field, for
   * the dashboard's persistent header indicator. Defaults to `false`
   * (verification on, Detour's behavior before this flag existed).
   */
  insecureUpstream?: boolean;
  /**
   * Caps the live backlog's *total* captured-body memory (issue #165),
   * independent of (and typically the tighter of the two, once bodies are
   * non-trivial) `backlogSize`'s item-count cap — 500 exchanges each
   * carrying a couple of base64'd 256 KB bodies is a very different memory
   * footprint from 500 carrying none at all. Evicts the oldest exchange(s)
   * once exceeded, same mechanism (and same "still in `historyStore` if
   * `--persist` is on") as hitting the count cap. `undefined` disables
   * this cap entirely (count-only, the pre-#165 behavior) — `cli.ts`
   * itself always passes a value (`--max-capture-memory`, default 64 MB);
   * this is only really `undefined` from a test double that doesn't care.
   */
  maxCaptureMemoryBytes?: number;
  /**
   * Enables WebSocket `permessage-deflate` compression on `/ws` (issue
   * #165's Proposal D) — `false` (the default, matching `ws`'s own
   * server-side default when this option is omitted entirely) means every
   * broadcast/backlog frame goes out uncompressed, exactly as before this
   * option existed. `undefined`/`false` are both "off".
   *
   * Measured via `scripts/bench.mjs`'s scenarios 9/10 (dashboard-connected,
   * a body large enough to hit the 256 KB capture cap, repeated over 8
   * connections for 10s): compressed and uncompressed came out
   * statistically identical on req/s and p95/p99 latency (both ~500 req/s,
   * ~20ms p95 — the WS broadcast was never the bottleneck at this scale to
   * begin with), while peak RSS was ~7.5x higher with compression on
   * (~265 MB vs ~1990 MB, reproduced across repeated runs) — exactly the
   * "catastrophic memory fragmentation" `ws`'s own README warns Node's
   * zlib binding is prone to under concurrent compression. No measured
   * upside, a severe and repeatable memory cost: left off by default, and
   * not recommended even via `--dashboard-compress` outside a deliberate
   * experiment on a bandwidth-constrained `--lan` connection (a case this
   * loopback-based benchmark can't itself validate one way or the other).
   * `threshold`/`concurrencyLimit` below are the ws-recommended values,
   * left as-is since there was no measured reason to tune them further.
   * `serverNoContextTakeover` is always forced on when this is enabled —
   * see its own comment at the `WebSocketServer` construction below for
   * the CRIME/BREACH-shaped risk a shared compression dictionary would
   * otherwise open up across every message this connection broadcasts.
   */
  dashboardCompression?: boolean;
  /**
   * Release check + self-update, so the dashboard can show a "new version"
   * banner and offer an Update button (see `dashboardUpdates.ts` for who may
   * trigger it). Omitted → no `updateInfo` is ever sent and `startUpdate` is
   * rejected.
   */
  updateService?: UpdateService;
  /**
   * The dashboard's switch for keeping `adb reverse` in place for USB Android devices
   * (`--adb-reverse`, see `adbReverseWatcher.ts`). `start` creates a watcher — called when
   * the switch is turned on, and its result is stopped when it is turned off or the server
   * stops; `enabledAtStart` is `detour start --adb-reverse`, so the flag and the switch
   * are one thing. Omitted → no `adbReverseState` is sent and `setAdbReverse` is ignored.
   */
  adbReverse?: {
    port: number;
    start: (onDevicesChanged: () => void) => AdbReverseWatcher;
    enabledAtStart?: boolean;
  };
  /**
   * Exchanges to preload into the live backlog before the first client
   * connects — what a Detour update carries across its restart so the open
   * dashboard keeps its traffic list. Replayed to every connecting client
   * exactly like freshly captured traffic. Not re-recorded to `historyStore`.
   */
  initialBacklog?: readonly CapturedExchange[];
}

const UPDATE_INFO_REFRESH_MS = 60 * 60 * 1000;

export interface DashboardServerHandle {
  /** Port the dashboard actually bound to (relevant when options.port is 0). */
  port: number;
  /** The control API's port, when `controlPort` was given (the real one even for `0`). */
  controlPort?: number;
  /** Address it actually bound to (`::1`, `127.0.0.1`, `0.0.0.0`, …) — what `localhost` resolved to, for the default bind. */
  address: string;
  /**
   * The live backlog, but only while a dashboard-initiated update is about to
   * stop this process (otherwise `undefined`) — what to write out for the
   * relaunched instance to resume from. Call it before `stop()`.
   */
  backlogForUpdateRestart(): CapturedExchange[] | undefined;
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
  // `let`, not `const`: `ensureRuleEngine` below (see its own doc comment)
  // reassigns this the first time it's actually needed — every read of
  // `ruleEngine` elsewhere in this function happens lazily inside a message
  // handler or a `broadcast()` callback, not at this line, so reassigning it
  // here is enough for those to see the newly-provisioned engine from that
  // point on.
  let ruleEngine = options.ruleEngine;
  const { ruleProfileStore, createRuleEngine } = options;
  const httpRequester = options.httpRequester ?? nodeHttpRequester;
  const lanAddrs = options.lanAddresses ?? [];
  // Computed once, not per-connection like `rulesMessage()`/`ruleProfilesMessage()`
  // below — a `--proto` schema has no live-reload (see `protoSchema`'s own
  // doc comment on `DashboardServerMessage`), so there's nothing for a later
  // call to pick up that this one wouldn't already have.
  // `protobuf.INamespace` (a plain-data description of protobufjs's own
  // schema types) has no index signature TypeScript will structurally match
  // against `Record<string, unknown>` — but it's genuinely just JSON going
  // out over the wire either way, so the cast is safe.
  const protoSchema = (options.protoRegistry?.toJSON() as Record<string, unknown> | undefined) ?? null;
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

  const backlog = new RingBuffer<CapturedExchange>(
    options.backlogSize ?? DEFAULT_BACKLOG_SIZE,
    (item) => item.id,
    options.maxCaptureMemoryBytes !== undefined
      ? { maxTotalBytes: options.maxCaptureMemoryBytes, sizeOf: capturedExchangeByteSize }
      : undefined,
  );
  for (const item of options.initialBacklog ?? []) backlog.upsert(item);
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
      if (end === -1) return undefined;
      // Same reasoning as the non-numeric-port check below, applied to the
      // bracketed form: whatever follows `]` must be empty (no port) or
      // `:<digits>` — a value like `[::1]:evil` shouldn't parse down to the
      // allowed hostname `::1` just because the bracket itself was well-formed.
      const rest = hostHeader.slice(end + 1);
      if (rest !== '' && !/^:\d+$/.test(rest)) return undefined;
      return hostHeader.slice(1, end).toLowerCase();
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
    if (lastColon === -1) return hostHeader.toLowerCase();
    // A single `:` is only legitimately `host:port` if what follows is
    // actually a port — a value like `localhost:evil` has exactly one `:`
    // too, but isn't of that form, and slicing it down to `localhost`
    // regardless would parse a malformed Host header into an allowed
    // hostname purely by accident. `/^\d+$/` (rather than also range-
    // checking 0-65535) is enough: it's already been established this isn't
    // an allowlisted name, so the actual port value played no role either way.
    if (!/^\d+$/.test(hostHeader.slice(lastColon + 1))) return undefined;
    return hostHeader.slice(0, lastColon).toLowerCase();
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
    // This dashboard is only ever served over http(s) — a browser-sent
    // `Origin` is always one of those two (or the literal string `null`,
    // already handled by the `new URL` throwing above), but a forged one
    // could claim any scheme. Fail closed rather than let `protocol !==
    // 'https:' → defaultPort 80` treat e.g. `chrome-extension://<id>` as an
    // http origin with no explicit port.
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    if (!allowedHostnames().includes(origin.hostname)) return false;
    if (origin.port !== '') return Number(origin.port) === boundPort;
    const defaultPort = origin.protocol === 'https:' ? 443 : 80;
    return defaultPort === boundPort;
  }

  /**
   * First visit with `?token=` (issue #205): a valid token is traded for the
   * session cookie and the browser is redirected to the same URL without it,
   * so the secret doesn't stay in the address bar, history or `Referer`. A
   * wrong one gets a plain 403 — and no cookie.
   */
  function exchangeTokenForCookie(req: http.IncomingMessage, res: http.ServerResponse, token: string): void {
    const presented = tokenFromUrl(req.url);
    if (presented === undefined || !tokensEqual(presented, token)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid dashboard token');
      return;
    }
    const attributes = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${60 * 60 * 24 * 365}`];
    if (options.tlsKeyCert) attributes.push('Secure');
    res.writeHead(302, {
      'Set-Cookie': `${DASHBOARD_SESSION_COOKIE}=${sessionCookieValue(token)}; ${attributes.join('; ')}`,
      Location: urlWithoutToken(req.url ?? '/'),
      'Cache-Control': 'no-store',
      // Keeps the token out of any `Referer` the redirect target might send.
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
  }

  const requestListener: http.RequestListener = (req, res) => {
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    if (options.accessToken && tokenFromUrl(req.url) !== undefined) {
      exchangeTokenForCookie(req, res, options.accessToken);
      return;
    }
    serveStatic(WEB_DIST_DIR, req, res);
  };
  // `https.Server` (issue #159) when `--lan` is on and TLS hasn't been
  // opted out of via `--dashboard-tls off` — see `tlsKeyCert`'s own doc
  // comment. Both share the same listen()/address()/close() shape
  // `net.Server` defines (`https.Server` extends it via `tls.Server`), so
  // everything below (binding, `WebSocketServer`, teardown) works unchanged
  // regardless of which one this actually is.
  const httpServer: http.Server | https.Server = options.tlsKeyCert
    ? https.createServer(options.tlsKeyCert, requestListener)
    : http.createServer(requestListener);
  const verifyClient: WebSocket.VerifyClientCallbackSync = (info) =>
    isAllowedHost(info.req.headers.host) && isAllowedOrigin(info.origin);
  // `perMessageDeflate: false` when `dashboardCompression` is off (the
  // default) is explicit rather than just omitting the option — `ws`
  // itself defaults to `false` server-side either way, but spelling it out
  // here makes the two states this option actually toggles between visible
  // at the call site, rather than relying on a reader already knowing `ws`'s
  // own default. See `DashboardServerOptions.dashboardCompression`'s doc
  // comment for the measurement behind this choice and its tuning.
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    verifyClient,
    perMessageDeflate: options.dashboardCompression
      ? {
          threshold: 1024,
          concurrencyLimit: 10,
          serverMaxWindowBits: 10,
          // Without this, `ws` negotiates context takeover by default
          // (reusing one compression dictionary across every message on
          // the connection, unless the *client* opts out) — every message
          // this socket ever broadcasts shares one connected client's whole
          // session (every exchange, every other feature's state changes),
          // so a shared dictionary is exactly the CRIME/BREACH-style
          // side-channel setup: an attacker who can get their own traffic
          // captured into the same stream (their own request through this
          // proxy) and observe this connection's encrypted frame sizes
          // could use the compression ratio's byte-count leakage to infer
          // another exchange's secret bytes (a session cookie, say) sharing
          // that dictionary (agy code review). Forcing a fresh dictionary
          // per message trades a little compression ratio for closing that
          // off entirely, regardless of what the client itself requests.
          serverNoContextTakeover: true,
        }
      : false,
  });

  // Who is authenticated, who proved a secret, the login rate limits (issues #66, #159, #205).
  const auth = createDashboardAuth({
    accessToken: options.accessToken,
    loadPasswordHash: () => loadUserConfig(options.userConfigPath).dashboardPasswordHash ?? null,
    sendInitialPayload: (socket) => sendInitialPayload(socket),
  });
  const dashboardUpdates = createDashboardUpdates(
    options.updateService,
    { isVerified: auth.isVerified },
    Date.now,
    (message) => broadcast({ type: 'updateStatus', state: 'failed', message }),
  );
  const sendUpdateInfo = async (socket: WebSocket) => {
    const message = await dashboardUpdates.infoFor(socket);
    if (message && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const sendUpdateInfoToAll = () => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && auth.isAuthenticated(client)) void sendUpdateInfo(client);
    }
  };
  const adbReverseOptions = options.adbReverse;
  const sendAdbReverseState = (socket: WebSocket) => {
    if (adbReverse && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(adbReverse.stateFor(socket)));
  };
  const sendAdbReverseStateToAll = () => {
    for (const client of wss.clients) {
      if (auth.isAuthenticated(client)) sendAdbReverseState(client);
    }
  };
  const adbReverse = adbReverseOptions
    ? createDashboardAdbReverse({
        port: adbReverseOptions.port,
        startWatcher: () => adbReverseOptions.start(sendAdbReverseStateToAll),
        enabledAtStart: adbReverseOptions.enabledAtStart,
        trust: { isVerified: auth.isVerified },
        onChange: sendAdbReverseStateToAll,
      })
    : undefined;
  const broadcast = (message: DashboardServerMessage) => {
    const payload = JSON.stringify(message);
    for (const client of wss.clients) {
      // Skips a socket still waiting on `authRequired` — the whole point of
      // gating it is that it never sees live traffic, rule contents, or any
      // other state until it's proven it knows the password.
      if (client.readyState === WebSocket.OPEN && auth.isAuthenticated(client)) client.send(payload);
    }
  };

  const onRequest = (exchange: Readonly<CapturedExchange>) => {
    backlog.upsert(exchange);
    // Encoded to base64 only right here, at the point of actually going out
    // over JSON — `backlog` above keeps the `Buffer` (issue #165's
    // Proposal B; see `toWireExchange`'s own doc comment).
    broadcast({ type: 'request', exchange: toWireExchange(exchange) });
  };
  const onResponse = (exchange: Readonly<CapturedExchange>) => {
    backlog.upsert(exchange);
    // Only the response-side diff goes out here (issue #165's Proposal C) —
    // `requestBody`/`requestHeaders` already went out in full on this same
    // id's `request` broadcast above and haven't changed since. `backlog`
    // itself still keeps (and replays to a newly-connecting client via
    // `toWireExchange` below) the complete exchange either way.
    broadcast({ type: 'response', exchange: toResponsePatch(exchange) });
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
    unreachableWarnings: ruleEngine ? [...ruleEngine.getUnreachableWarnings()] : [],
    scriptWarnings: ruleEngine ? [...ruleEngine.getScriptWarnings()] : [],
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
        dashboardPasswordSet: !!auth.currentPasswordHash(),
      },
    };
  };
  const broadcastError = (errorKind: string, message: string) =>
    broadcast({ type: 'error', event: { errorKind, message } });
  /** Whether `url` points at one of this process's own listeners (issue #214 — the URL is now editable, so Replay could otherwise be aimed at the dashboard itself, see #205). Unparseable URLs aren't refused here: the request fails on its own and says why. */
  const targetsOwnListener = async (url: string): Promise<boolean> => {
    if (!options.isSelfTarget) return false;
    try {
      const target = new URL(url);
      const defaultPort = target.protocol === 'https:' ? 443 : 80;
      return await options.isSelfTarget(target.hostname, target.port ? Number(target.port) : defaultPort);
    } catch {
      return false;
    }
  };
  const handleReplayMessage = async (message: Extract<DashboardClientMessage, { type: 'replay' }>) => {
    const url = message.overrides?.url?.trim() || message.exchange.url;
    if (await targetsOwnListener(url)) {
      broadcastError('REPLAY_REJECTED', `Refused to replay to ${url}: it is one of Detour's own listeners.`);
      return;
    }
    // Fire-and-forget: `replayExchange` never rejects (network failures land
    // in the replayed exchange's own `error` field, see its doc comment) —
    // this catch only guards against a genuine bug.
    void replayExchange(message.exchange, eventBus, httpRequester, message.overrides).catch((err) =>
      broadcastError('REPLAY_ERROR', describeError(err)),
    );
  };
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
    broadcast({ type: 'breakpoint', exchange: toWireExchange(exchange), payload });
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
      const proxyInfoMessage: DashboardServerMessage = {
        type: 'proxyInfo',
        proxyPort: options.proxyPort,
        insecureUpstream: options.insecureUpstream ?? false,
        protocolVersion: PROTOCOL_VERSION,
      };
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
    const backlogMessage: DashboardServerMessage = { type: 'backlog', items: backlog.toArray().map(toWireExchange) };
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
    const protoSchemaMessage: DashboardServerMessage = { type: 'protoSchema', schema: protoSchema };
    socket.send(JSON.stringify(protoSchemaMessage));
    const historyStatusMessage: DashboardServerMessage = { type: 'historyStatus', enabled: !!options.historyStore };
    socket.send(JSON.stringify(historyStatusMessage));
    // Last and unawaited: the release lookup may hit the network, and must
    // never delay the snapshot above.
    void sendUpdateInfo(socket);
    sendAdbReverseState(socket);
  };

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const admission = auth.admitConnection(socket, req);
    if (admission === 'rejected') return;
    if (admission === 'authenticated') sendInitialPayload(socket);
    else socket.send(JSON.stringify(auth.authRequiredMessage()));

    // Browser → server traffic on this socket: `login` before authenticating, then every other client
    // message through the handler table (`dashboardMessageHandlers.ts`). Control messages (breakpoint,
    // intercept, focus, throttle, block hosts) are relayed onto the event bus, where the proxy server is
    // waiting on them; rules editing/profiles (issue #19) live in `dashboardRulesHandlers.ts` and are handled
    // directly, since they need synchronous validation and per-attempt error feedback that a
    // fire-and-forget event emit cannot give.
    // `async`, not sync: `verifyPassword`/`hashPassword` are async precisely so scrypt's work runs off the
    // main thread (see `domain/auth/passwordHash.ts`) — awaiting them is what actually gets that benefit.
    // `ws` doesn't care that the listener returns a promise; nothing here needs the caller to wait on it.
    socket.on('message', async (raw) => {
      try {
        const parsed = parseClientMessage(raw.toString());
        const authenticated = auth.isAuthenticated(socket);
        if (!parsed.ok) {
          // Reported only for an authenticated socket (issue #209): before
          // login a frame is just noise from a stranger, and logging each
          // one would hand them a way to flood this process's log.
          if (authenticated) {
            eventBus.emit('error', {
              errorKind: 'DASHBOARD_BAD_MESSAGE',
              message: `Rejected a malformed dashboard message — ${parsed.reason}`,
            });
          }
          return;
        }
        const message = parsed.message;

        if (!authenticated) {
          // Nothing but `login` is honored before authenticating — a
          // malicious device on the network that skipped straight to
          // `setRules`/`replay`/etc. without ever proving it knows the
          // password gets silently ignored, same as a malformed frame.
          if (message.type === 'login') await auth.handleLogin(socket, message);
          return;
        }

        // Already authenticated: a further `login` has nothing left to do.
        if (message.type === 'login') return;
        await dispatchMessage(messageHandlers, message, socket);
      } catch (err) {
        // Frames are validated above, so reaching here means the handler
        // itself threw — a bug, not a bad client. Surfaced rather than
        // swallowed (issue #209), and it still can't crash the dashboard.
        eventBus.emit('error', {
          errorKind: 'DASHBOARD_HANDLER_ERROR',
          message: `A dashboard message handler failed — ${describeError(err)}`,
        });
      }
    });
  });

  /**
   * Returns the session's `ruleEngine`, provisioning one via
   * `createRuleEngine` (issue #123) the first time it's actually needed —
   * see `DashboardServerOptions.createRuleEngine`'s own doc comment. Only
   * `applyRuleProfile` calls this: it's the one action reachable with no
   * active rules file at all (the "Switch profile…" `<select>` lists saved
   * profiles regardless of whether one's currently applied), whereas
   * `setRules`/`saveActiveRulesAsProfile` are both inherently about editing
   * or snapshotting an *already*-active ruleset, with nothing for a freshly
   * created empty one to meaningfully contribute.
   */
  function ensureRuleEngine(): RuleEngine | undefined {
    if (ruleEngine) return ruleEngine;
    if (!createRuleEngine) return undefined;
    ruleEngine = createRuleEngine();
    return ruleEngine;
  }

  const messageHandlers = createMessageHandlers({
    eventBus,
    rules: createRulesHandlers({
      getRuleEngine: () => ruleEngine,
      ensureRuleEngine,
      ruleProfileStore,
      broadcast,
      broadcastError,
      ruleProfilesMessage,
    }),
    broadcast,
    broadcastError,
    userConfigMessage,
    sendUpdateInfoToAll,
    persistUserConfig: (patch) => writeUserConfig(patch, options.userConfigPath),
    onDashboardPasswordChanged: auth.onPasswordChanged,
    startUpdate: (socket) => dashboardUpdates.start(socket),
    refreshUpdateInfo: () => dashboardUpdates.refresh(),
    setAdbReverse: (socket, enabled) => adbReverse?.setEnabled(socket, enabled) ?? false,
    sendAdbReverseState,
    replay: handleReplayMessage,
    queryHistory: (query) => options.historyStore?.query(query),
  });

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

      // Keeps a long-open tab current: the lookup itself is cached, so this
      // is cheap — it only matters once the cache has expired.
      const updateTimer = options.updateService ? setInterval(sendUpdateInfoToAll, UPDATE_INFO_REFRESH_MS) : undefined;
      updateTimer?.unref();

      const address = httpServer.address();
      // Reassigns the outer `let boundPort` (declared up top, alongside
      // `isAllowedOrigin`'s doc comment on why) — not a new binding — so an
      // ephemeral `port: 0` resolving to a real OS-assigned port here is
      // what `isAllowedOrigin` checks handshakes against from this point on.
      boundPort = typeof address === 'object' && address ? address.port : options.port;
      const buildHandle = (control: ControlServerHandle | undefined): DashboardServerHandle => {
        adbReverse?.begin();
        return {
          port: boundPort,
          ...(control ? { controlPort: control.port } : {}),
          address: typeof address === 'object' && address ? address.address : host,
          backlogForUpdateRestart: () => (dashboardUpdates.isUpdating() ? backlog.toArray() : undefined),
          stop: () =>
            new Promise<void>((res) => {
              // Awaited, not fired and forgotten: a caller that treats a resolved
              // `stop()` as "every port is released" (a test restarting Detour on
              // a fixed `--control-port`) must not find the control listener
              // still bound.
              const controlStopped = control?.stop() ?? Promise.resolve();
              // The dashboard's switch may have started a watcher `detour start` never saw — stop whichever is running.
              adbReverse?.stop();
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
              if (updateTimer) clearInterval(updateTimer);
              for (const client of wss.clients) client.close();
              // `httpServer.close()` waits for every connection, so one client
              // that never answers the close handshake (or a stray keep-alive)
              // would block shutdown forever (issue #206) — cut what remains
              // after a short drain.
              const force = setTimeout(() => {
                for (const client of wss.clients) client.terminate();
                httpServer.closeAllConnections();
              }, SHUTDOWN_DRAIN_MS);
              force.unref();
              wss.close(() =>
                httpServer.close(() => {
                  clearTimeout(force);
                  void controlStopped.then(() => res());
                }),
              );
            }),
        };
      };
      // The control API (issue #212) comes up with the dashboard, or not at
      // all: if it cannot bind, the whole start fails rather than leaving a
      // session whose test runner has nothing to talk to.
      if (options.controlPort === undefined) {
        resolve(buildHandle(undefined));
        return;
      }
      if (!options.accessToken) {
        // Unreachable from `detour start`; guards a direct caller. The API is
        // never offered without the secret that protects it.
        httpServer.close();
        reject(new Error('The control API needs an access token'));
        return;
      }
      startControlServer(
        { port: options.controlPort, token: options.accessToken },
        createControlDeps({
          eventBus,
          getRuleEngine: () => ruleEngine,
          ensureRuleEngine,
          profiles: () => ruleProfileStore,
          backlog,
          version: options.version,
        }),
      ).then(
        (control) => resolve(buildHandle(control)),
        (err: unknown) => {
          // The dashboard is already listening; release it so the caller is
          // not left holding half a start — and only then report the failure,
          // so "the start failed" can be trusted to mean "no port is held".
          wss.close(() => httpServer.close(() => reject(err)));
        },
      );
    });
  });
}
