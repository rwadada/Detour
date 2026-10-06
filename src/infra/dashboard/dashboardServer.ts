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
import { SAMPLE_RULES_FILE } from '../../domain/rules/sample';
import { findRejectedScriptWrites } from '../../domain/rules/scriptGate';
import type { RulesFile } from '../../domain/rules/types';
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
  requestHasValidToken,
  sessionCookieValue,
  tokenFromUrl,
  tokensEqual,
  urlWithoutToken,
} from '../../domain/auth/dashboardAccess';
import { hashPassword, verifyPassword } from '../../domain/auth/passwordHash';
import type { UpdateService } from '../../domain/update/updateService';
import { parseClientMessage } from '../../domain/dashboard/clientMessage';
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

  // Issue #66's optional dashboard password: sockets that have proven they
  // know the current password (or connected while none was configured — see
  // `wss.on('connection', ...)` below) live in this set. A `WeakSet` rather
  // than a plain property on the socket so nothing here needs to remember to
  // clean up on close — an unreachable socket just falls out of it.
  const authenticatedSockets = new WeakSet<WebSocket>();
  // The subset of `authenticatedSockets` that really proved a secret — a
  // password via `login`, or the access token (issue #205) — as opposed to
  // being grandfathered in while neither was required. This is what decides
  // who may trigger a self-update (see `createDashboardUpdates`); where a
  // connection came *from* (loopback) deliberately plays no part, since the
  // proxy relays LAN clients' requests from loopback.
  // `let` so that changing the password can revoke every earlier proof at once.
  let passwordVerifiedSockets = new WeakSet<WebSocket>();
  const tokenVerifiedSockets = new WeakSet<WebSocket>();
  const dashboardUpdates = createDashboardUpdates(
    options.updateService,
    {
      isVerified: (socket) => passwordVerifiedSockets.has(socket) || tokenVerifiedSockets.has(socket),
    },
    Date.now,
    (message) => broadcast({ type: 'updateStatus', state: 'failed', message }),
  );
  const sendUpdateInfo = async (socket: WebSocket) => {
    const message = await dashboardUpdates.infoFor(socket);
    if (message && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const sendUpdateInfoToAll = () => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && authenticatedSockets.has(client)) void sendUpdateInfo(client);
    }
  };
  // Sockets with a `login` currently awaiting `verifyPassword` —
  // guards against two `login` frames racing each other: both would pass
  // the `!authenticatedSockets.has(socket)` check below before either
  // resolves, and depending on which `await` settles second, that one could
  // send `authFailed` after the socket was already authenticated by the
  // first, or duplicate the initial snapshot. A `login` that arrives while
  // one's already in flight for that socket is dropped rather than queued —
  // a real client only ever has one outstanding attempt at a time.
  const loginInFlight = new WeakSet<WebSocket>();
  // Login rate limiting (issue #159): `dashboardServer.ts` had nothing
  // beyond `loginInFlight`'s single-socket concurrency guard, so a `--lan`-
  // exposed password could be brute-forced at whatever rate a client's own
  // sequential attempts (or however many parallel sockets it opened)
  // allowed. Tracked by *IP*, not per-socket — closing a socket and opening
  // a fresh one is free, so a per-socket counter would reset on every
  // reconnect and defend nothing. In-memory only: resetting on a `detour
  // start` restart is fine, nothing here needs to survive one.
  const MAX_LOGIN_FAILURES = 5;
  const MAX_UNAUTHENTICATED_SOCKETS_PER_IP = 3;
  const LOGIN_BACKOFF_BASE_MS = 20;
  const LOGIN_BACKOFF_MAX_MS = 320;
  // Bounds how many distinct IPs `loginFailuresByIp` tracks at once (Copilot
  // review, PR #175) — unlike `unauthenticatedSocketCountByIp` (an entry is
  // always removed on auth/close, so it can never outgrow the number of
  // sockets actually open right now), a failure record has no such natural
  // ceiling: it lives until that IP eventually logs in successfully, which
  // an attacker has no reason to ever do. Enough distinct source IPs
  // failing once would otherwise grow this map forever. `recordLoginFailure`
  // evicts the oldest-inserted entry once at this cap, rather than refusing
  // new ones — a memory ceiling matters more here than perfect fairness
  // toward whichever IP happens to hit it first.
  const MAX_TRACKED_LOGIN_FAILURE_IPS = 1000;
  const loginFailuresByIp = new Map<string, number>();
  const unauthenticatedSocketCountByIp = new Map<string, number>();
  // Which sockets currently hold a counted slot in
  // `unauthenticatedSocketCountByIp` — released (see `releaseUnauthenticatedSlot`)
  // exactly once, whichever of "authenticated" or "closed" happens first,
  // so the count never double-decrements if both eventually fire for the
  // same socket.
  const unauthenticatedSlotSockets = new WeakSet<WebSocket>();

  /** The IP a connection's rate-limit counters are tracked under — the raw socket address, not anything a client-controlled header could spoof. */
  function clientIp(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? 'unknown';
  }

  /** Releases `socket`'s counted slot in `unauthenticatedSocketCountByIp` (idempotent — a no-op if it never held one, or already released it). */
  function releaseUnauthenticatedSlot(socket: WebSocket, ip: string): void {
    if (!unauthenticatedSlotSockets.has(socket)) return;
    unauthenticatedSlotSockets.delete(socket);
    const current = unauthenticatedSocketCountByIp.get(ip) ?? 0;
    if (current <= 1) unauthenticatedSocketCountByIp.delete(ip);
    else unauthenticatedSocketCountByIp.set(ip, current - 1);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Records one more login failure for `ip` and returns its new total, evicting the oldest-tracked IP first if `loginFailuresByIp` is already at its cap (see that map's own doc comment). */
  function recordLoginFailure(ip: string): number {
    const failures = (loginFailuresByIp.get(ip) ?? 0) + 1;
    if (!loginFailuresByIp.has(ip) && loginFailuresByIp.size >= MAX_TRACKED_LOGIN_FAILURE_IPS) {
      const oldestIp = loginFailuresByIp.keys().next().value;
      if (oldestIp !== undefined) loginFailuresByIp.delete(oldestIp);
    }
    loginFailuresByIp.set(ip, failures);
    return failures;
  }

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
        dashboardPasswordSet: !!currentPasswordHash(),
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
  };

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    // No password configured: grandfather this socket in permanently, even
    // if a password gets set later while it's still open — same "changing
    // the Wi-Fi password doesn't kick already-connected devices" posture as
    // `--lan`'s own bind-at-spawn-time semantics. Only *new* connections
    // made after that point are asked for it.
    if (!currentPasswordHash()) {
      if (!options.accessToken) {
        authenticatedSockets.add(socket);
      } else if (requestHasValidToken(options.accessToken, { url: req.url, cookieHeader: req.headers.cookie })) {
        authenticatedSockets.add(socket);
        tokenVerifiedSockets.add(socket);
      }
    }

    const ip = clientIp(req);
    if (!authenticatedSockets.has(socket)) {
      // An IP that's already exhausted its attempts (see
      // `handleLoginMessage`) doesn't get a fresh set just by reconnecting —
      // closing a socket and opening a new one is free, so a per-socket-only
      // limit would defend nothing.
      if ((loginFailuresByIp.get(ip) ?? 0) >= MAX_LOGIN_FAILURES) {
        socket.close(1008, 'Too many failed login attempts');
        return;
      }
      // Bounds how many *unauthenticated* sockets one IP can hold open at
      // once (issue #159) — without this, one client could open many
      // parallel connections to run scrypt verifications concurrently
      // (`login`'s KDF work runs on libuv's shared threadpool — see
      // `domain/auth/passwordHash.ts` — so enough parallel attempts starve
      // every other `fs`-backed operation sharing that pool, rules/dump/
      // cert reads included) or to spread brute-force attempts across more
      // sockets than the per-socket concurrency guard (`loginInFlight`)
      // alone limits.
      const unauthenticatedCount = unauthenticatedSocketCountByIp.get(ip) ?? 0;
      if (unauthenticatedCount >= MAX_UNAUTHENTICATED_SOCKETS_PER_IP) {
        socket.close(1008, 'Too many concurrent unauthenticated connections');
        return;
      }
      unauthenticatedSocketCountByIp.set(ip, unauthenticatedCount + 1);
      unauthenticatedSlotSockets.add(socket);
      socket.once('close', () => releaseUnauthenticatedSlot(socket, ip));
    }

    if (authenticatedSockets.has(socket)) {
      sendInitialPayload(socket);
    } else {
      const authRequiredMessage: DashboardServerMessage = {
        type: 'authRequired',
        method: currentPasswordHash() ? 'password' : 'token',
      };
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
    // `async`, not sync: `verifyPassword`/`hashPassword`
    // below are async precisely so scrypt's work runs off the main thread
    // (see `domain/auth/passwordHash.ts`) — awaiting them here is what actually
    // gets that benefit, rather than serializing right back onto this
    // handler anyway. `ws` doesn't care that the listener returns a promise;
    // nothing here needs the caller to wait on it.
    socket.on('message', async (raw) => {
      try {
        const parsed = parseClientMessage(raw.toString());
        const authenticated = authenticatedSockets.has(socket);
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
          if (message.type === 'login') await handleLoginMessage(socket, ip, message);
          return;
        }

        if (message.type === 'breakpointResume') eventBus.emit('breakpointResume', message.command);
        else if (message.type === 'setIntercept') eventBus.emit('setIntercept', message.enabled);
        else if (message.type === 'setFocus') eventBus.emit('setFocus', message.hosts);
        else if (message.type === 'setThrottle') eventBus.emit('setThrottle', message.state);
        else if (message.type === 'setBlockHosts') eventBus.emit('setBlockHosts', message.state);
        else if (message.type === 'startUpdate') socket.send(JSON.stringify(await dashboardUpdates.start(socket)));
        else if (message.type === 'checkUpdate') {
          await dashboardUpdates.refresh();
          sendUpdateInfoToAll();
        } else if (message.type === 'replay') {
          await handleReplayMessage(message);
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
            const dashboardPasswordHash = message.password === null ? null : await hashPassword(message.password);
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
            // A session that logged in with the old password must not keep
            // the right to run a host-level update after it's been changed.
            passwordVerifiedSockets = new WeakSet<WebSocket>();
            sendUpdateInfoToAll();
            broadcast(userConfigMessage());
          } catch (err) {
            broadcastError('USER_CONFIG_WRITE_ERROR', describeError(err));
          }
        } else if (message.type === 'queryHistory') {
          // Sent to the requesting socket only (never `broadcast`) — this
          // answers one tab's own query, not a shared-state change every
          // connected tab needs to hear about. Answered even with no
          // `historyStore` (empty/`hasMore: false`) rather than dropped —
          // see the wire type's own doc comment for why. A query failure
          // (e.g. a corrupt DB file) must still answer with something,
          // same reasoning — otherwise the requester's History UI is stuck
          // showing `loading: true` forever with no way to know why.
          let result: { items: CapturedExchange[]; hasMore: boolean };
          try {
            result = options.historyStore?.query(message.query) ?? { items: [], hasMore: false };
          } catch (err) {
            eventBus.emit('error', { errorKind: 'HISTORY_QUERY_ERROR', message: describeError(err) });
            result = { items: [], hasMore: false };
          }
          const reply: DashboardServerMessage = {
            type: 'historyResult',
            requestId: message.requestId,
            items: result.items.map(toWireExchange),
            hasMore: result.hasMore,
          };
          socket.send(JSON.stringify(reply));
        } else handleRulesMessage(message);
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
   * Answers a `login` attempt from a not-yet-authenticated socket — pulled
   * out of the `socket.on('message', ...)` handler both for its own sake
   * (that handler was getting long) and to keep `loginInFlight`'s
   * add/try/finally/delete dance visually separate from the message
   * dispatch it's guarding.
   */
  async function handleLoginMessage(
    socket: WebSocket,
    ip: string,
    message: Extract<DashboardClientMessage, { type: 'login' }>,
  ): Promise<void> {
    if (loginInFlight.has(socket)) return;
    loginInFlight.add(socket);
    try {
      const hash = currentPasswordHash();
      let verified: boolean;
      try {
        // No password configured: nothing to verify against, so `login` can
        // only succeed where the dashboard is open — never where the access
        // token is what protects it (issue #205), or a `login` with any
        // string would get past it.
        verified = hash ? await verifyPassword(message.password, hash) : !options.accessToken;
      } catch {
        // A crypto failure verifying the password is the server's problem,
        // not proof the client is wrong — but it still needs *some*
        // response. The outer `socket.on('message', ...)` handler's own
        // catch would otherwise swallow this silently, stranding the socket
        // locked out with no `authFailed` to prompt a retry.
        verified = false;
      }
      if (verified) {
        loginFailuresByIp.delete(ip);
        releaseUnauthenticatedSlot(socket, ip);
        authenticatedSockets.add(socket);
        passwordVerifiedSockets.add(socket);
        sendInitialPayload(socket);
        return;
      }
      // Exponential backoff (issue #159) before even answering: makes each
      // successive wrong guess from this IP slower than the last, on top of
      // scrypt's own ~20ms+ per attempt — friction a plain
      // `Math.min`-capped delay adds cheaply, well before the hard cutoff
      // below ever kicks in.
      const failures = recordLoginFailure(ip);
      await sleep(Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** (failures - 1), LOGIN_BACKOFF_MAX_MS));
      // The socket (or the whole server) could have gone away during that
      // delay — nothing left to answer or disconnect.
      if (socket.readyState !== WebSocket.OPEN) return;
      const authFailedMessage: DashboardServerMessage = { type: 'authFailed' };
      socket.send(JSON.stringify(authFailedMessage));
      // Issue #159's acceptance criterion: the 5th consecutive failure from
      // an IP ends that socket outright, rather than leaving it free to
      // keep guessing indefinitely — reconnecting doesn't help either,
      // since `wss.on('connection', ...)` checks this same counter before a
      // new socket is ever handed an `authRequired` at all.
      if (failures >= MAX_LOGIN_FAILURES) {
        socket.close(1008, 'Too many failed login attempts');
      }
    } finally {
      loginInFlight.delete(socket);
    }
  }

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

  function handleRulesMessage(message: DashboardClientMessage): void {
    if (message.type === 'setRules') {
      if (!ruleEngine) return broadcastError('RULES_WRITE_ERROR', 'No rules file is configured for this session.');
      // Issue #161: refuse a `setRules` write that adds a brand-new `script`
      // rule or changes an existing one's `path`, regardless of whether
      // `--allow-scripts` is on — this closes the network-reachable half of
      // the `setRules` → `script` → `require()` chain without touching the
      // read side (a `script` rule already in rules.json keeps running,
      // subject to `--allow-scripts`, however it got there). Checked before
      // the `try` below since this is a validation failure, not a write
      // failure — nothing has been written yet either way.
      const scriptViolations = findRejectedScriptWrites(ruleEngine.getRules(), message.data.rules);
      if (scriptViolations.length > 0) {
        return broadcastError('RULES_WRITE_ERROR', scriptViolations.join('; '));
      }
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
      // Checked *before* `ensureRuleEngine()` — that call can have the real
      // side effect of writing a rules file and starting a watcher on it
      // (see `DashboardServerOptions.createRuleEngine`'s own doc comment);
      // nothing about this request can succeed without `ruleProfileStore`
      // regardless, so there's no reason to provision an engine only to
      // then reject it.
      if (!ruleProfileStore) return broadcastError('RULE_PROFILE_ERROR', 'Rule profiles are unavailable.');
      try {
        // Inside the `try`, not before it: `ensureRuleEngine()` can throw
        // (a `createRuleEngine` factory failing to write/load its rules
        // file) just as readily as `engine.write()`/`ruleProfileStore.read()`
        // below can — leaving it uncaught would silently drop the whole
        // message (the outer `socket.on('message', ...)` handler's own
        // catch exists only to survive a malformed frame, not to report a
        // real failure), leaving the client with no `RULE_PROFILE_ERROR`
        // and the dashboard looking stuck rather than told why.
        const engine = ensureRuleEngine();
        if (!engine) return broadcastError('RULE_PROFILE_ERROR', 'Rule profiles are unavailable.');
        const profileRules = ruleProfileStore.read(message.name).rules;
        // Same reasoning as `setRules`'s own check above (issue #161):
        // `applyRuleProfile` is an equally network-reachable way to change
        // what's active, so it has to be gated the same way — a saved
        // profile can (validly, and without any check of its own) carry a
        // `script` rule from a time it was legitimately active, e.g. via
        // `saveActiveRulesAsProfile` or a profile saved before this gate
        // existed. Applying it back must not resurrect a `script` rule (or
        // change its path) that isn't already active right now, exactly as
        // `setRules` itself can't.
        const scriptViolations = findRejectedScriptWrites(engine.getRules(), profileRules);
        if (scriptViolations.length > 0) {
          return broadcastError('RULE_PROFILE_ERROR', scriptViolations.join('; '));
        }
        engine.write(profileRules, { activeProfile: message.name });
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
      resolve({
        port: boundPort,
        address: typeof address === 'object' && address ? address.address : host,
        backlogForUpdateRestart: () => (dashboardUpdates.isUpdating() ? backlog.toArray() : undefined),
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
                res();
              }),
            );
          }),
      });
    });
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
