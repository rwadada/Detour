import type {
  BlockHostsState,
  BreakpointPayload,
  BreakpointResumeCommand,
  CapturedExchange,
  CapturedWebSocketConnection,
  FocusState,
  InterceptState,
  ProxyErrorEvent,
  ThrottleState,
} from '../exchange/types';
import type { RuleProfileSummary } from '../rules/profile';
import type { ScriptGateWarning } from '../rules/scriptGate';
import type { RulesFile } from '../rules/types';
import type { UnreachableRuleWarning } from '../rules/unreachableRules';

/**
 * Filters for a `queryHistory` request (issue #144's optional SQLite
 * persistence, beyond the live in-memory backlog's item-count/body-size
 * caps) — every field is optional; omitted means "no restriction" on that
 * field. Shared as-is between the wire message and `HistoryStore.query`'s
 * own parameter (see `infra/persistence/historyStore.ts`), so there's one
 * definition of what a history query can filter on rather than two that
 * could drift apart.
 */
export interface HistoryFilters {
  /** Exact (case-sensitive) HTTP method match, e.g. `'GET'`. */
  method?: string;
  /** Exact (case-sensitive) host match, e.g. `'api.example.com'`. */
  host?: string;
  /** Case-insensitive substring match against the exchange's full URL. */
  urlContains?: string;
  statusMin?: number;
  statusMax?: number;
}

/**
 * One page of a `queryHistory` request. `before`/`beforeId` together are the
 * oldest item's `startedAt`/`id` from the previous page — omit both for the
 * first (most recent) page, pass both to page further back in time.
 * `startedAt` alone (ms resolution) isn't a stable cursor on its own: two
 * exchanges captured in the same millisecond are common under load, and
 * paging on `started_at < before` alone can permanently skip whichever of
 * them didn't make it into the previous page. `id` (unique per exchange)
 * breaks the tie deterministically — see `historyStore.ts`'s
 * `buildWhereClause`. `limit` bounds how many rows come back;
 * `HistoryQueryResult.hasMore` says whether an older page than this one
 * still exists.
 */
export interface HistoryQuery extends HistoryFilters {
  before?: number;
  /** Paired with `before` — see this interface's own doc comment. Only meaningful when `before` is also set. */
  beforeId?: string;
  limit: number;
}

/**
 * The persistent `detour start` defaults a dashboard client can view/edit —
 * mirrors `~/.detour/config.json` (see `src/infra/fs/userConfigStore.ts` and
 * `detour config`). Unlike `InterceptState`/`FocusState`/etc. below, this
 * isn't live proxy behavior: both fields take effect on the *next* `detour
 * start`, never this running instance — a process's foreground/detached mode
 * and a bound TCP server's address are both fixed at spawn time and can't be
 * changed out from under it.
 */
export interface UserConfigState {
  /** Whether `detour start` runs detached by default (as if `--detach` were always passed) — `detour config --default-detach`. */
  defaultDetach: boolean;
  /** Whether `detour start` binds the *dashboard* to every network interface (`0.0.0.0`) instead of just `localhost` — `detour config --lan`. Never affects the proxy, which always binds to every interface regardless (see cli.ts's `PROXY_HOST`). Security-sensitive: LAN access has no authentication of its own, so anything on the network can reach the dashboard and, from there, decrypted HTTPS traffic and rule edits. */
  lanAccess: boolean;
  /**
   * Whether a dashboard password is currently required (issue #66's optional
   * auth) — `detour config --dashboard-password <value>` or the Settings
   * panel. Never the hash or plaintext itself, just whether one is set;
   * unlike `defaultDetach`/`lanAccess`, this takes effect immediately for
   * new connections rather than on the next `detour start`.
   */
  dashboardPasswordSet: boolean;
}

/**
 * Messages sent from the dashboard server to a connected browser client over
 * the `/ws` WebSocket. Kept in one place so the wire format has a single
 * source of truth; the frontend (web/src/lib/protocol.ts) mirrors this shape
 * by hand since it's built as a separate, standalone package.
 */
export type DashboardServerMessage =
  /**
   * Sent once, right after connecting: the proxy port this dashboard session
   * is fronting (issue #24's sidebar Proxy URL / QR code). The dashboard
   * itself is served on `proxyPort + 1000` by default (see `cli.ts`'s
   * `--dashboard-port`), but sent explicitly rather than left for the
   * client to back-compute — `--dashboard-port` can still be overridden
   * independently of that default.
   *
   * `insecureUpstream` (issue #160) is this session's `--insecure-upstream`
   * setting — fixed for the process's whole lifetime, unlike every other
   * field sent here or in the rest of this just-connected snapshot, so it's
   * carried on this one-time message rather than needing its own `set*`/
   * `*Changed` pair. The dashboard shows this as a persistent header
   * indicator (not a toast) for as long as a client stays connected: it
   * means upstream TLS certificate errors are being silently ignored for
   * this entire session, and that's not something a user should be able to
   * miss by looking away for a moment.
   */
  | { type: 'proxyInfo'; proxyPort: number; insecureUpstream: boolean }
  /**
   * Sent once, right after connecting (issue #66): every non-internal IPv4
   * address this machine has. Non-empty regardless of `--lan`/`lanAccess` —
   * the proxy always binds to every network interface (see cli.ts's
   * `PROXY_HOST`), so its LAN address(es) are always worth showing. Lets
   * the dashboard show the actual URL(s) another device on the network
   * should use, instead of only ever knowing the address the current
   * browser tab happens to be viewing it from (which is `localhost` unless
   * this tab itself was opened over LAN).
   *
   * `dashboardOnLan` is the one piece that *does* still depend on
   * `--lan`/`lanAccess`: whether the *dashboard* (unlike the proxy) is
   * itself bound to every interface right now, so the client knows whether
   * to also show a Dashboard URL alongside the Proxy one for each address —
   * showing one that's actually `localhost`-only elsewhere on the network
   * would just be a dead link. The dashboard's own port isn't included
   * here either way — a connected client already knows it as
   * `window.location.port`, the same page it's looking at right now.
   *
   * Optional here even though this server always sends it (see
   * `dashboardServer.ts`'s `sendInitialPayload`) — this file is meant as
   * the wire format's single source of truth, and the wire itself can
   * still carry a message without it (an older server build predating
   * this field talking to a newer web build, say). `web/src/shared/api/
   * protocol.ts`'s copy of this type is genuinely optional for exactly
   * that reason (see `createProxyInfoStore`'s fallback) — matching that
   * here keeps the two declared wire formats in agreement about what can
   * actually show up on the wire, not just what this particular server
   * happens to always send.
   */
  | { type: 'lanInfo'; addresses: string[]; dashboardOnLan?: boolean }
  /**
   * Sent instead of the usual just-connected snapshot (`backlog`, `rules`,
   * `userConfig`, etc. below) when a dashboard password is configured and
   * this socket hasn't supplied it yet (issue #66's optional auth) — the
   * client should prompt for one and reply with `login`. Not sent at all
   * when no password is configured; the snapshot goes out immediately in
   * that case, same as before this feature existed.
   */
  | { type: 'authRequired' }
  /** A `login` message's password didn't match — the socket stays unauthenticated (no snapshot, no traffic) and can retry. */
  | { type: 'authFailed' }
  /** Sent once, right after connecting: the recent-history backlog so a client that (re)connects mid-session isn't starting from a blank table. */
  | { type: 'backlog'; items: CapturedExchange[] }
  /** Sent once, right after connecting: the recent WebSocket connection backlog (see `backlog` above; issue #17). */
  | { type: 'wsBacklog'; items: CapturedWebSocketConnection[] }
  /** A request finished sending to the upstream server (may still be awaiting a response). */
  | { type: 'request'; exchange: CapturedExchange }
  /** A request/response exchange finished. */
  | { type: 'response'; exchange: CapturedExchange }
  /** A proxy-level error (connection reset, TLS failure, rules.json reload failure, etc). */
  | { type: 'error'; event: ProxyErrorEvent }
  /**
   * A `breakpoint` rule paused this exchange. `exchange` is a transient
   * snapshot with `breakpoint` set (see `CapturedExchange.breakpoint`) — for
   * table/row display; `payload` carries the full editable request/response
   * content for the breakpoint editor.
   */
  | { type: 'breakpoint'; exchange: CapturedExchange; payload: BreakpointPayload }
  /**
   * The current intercept on/off state — sent once right after connecting
   * (alongside `backlog`) so a (re)connecting client starts in sync, and
   * again on every change so all connected tabs stay in sync with each other.
   */
  | { type: 'intercept'; state: InterceptState }
  /**
   * The current Focus host allowlist — sent once right after connecting
   * (alongside `backlog`) so a (re)connecting client starts in sync, and
   * again on every change so all connected tabs stay in sync with each other.
   */
  | { type: 'focus'; state: FocusState }
  /**
   * The current Throttle profile — sent once right after connecting
   * (alongside `backlog`) so a (re)connecting client starts in sync, and
   * again on every change so all connected tabs stay in sync with each other.
   */
  | { type: 'throttle'; state: ThrottleState }
  /**
   * The current Block Hosts denylist — sent once right after connecting
   * (alongside `backlog`) so a (re)connecting client starts in sync, and
   * again on every change so all connected tabs stay in sync with each other.
   */
  | { type: 'blockHosts'; state: BlockHostsState }
  /**
   * A proxied WebSocket connection completed its upgrade handshake (issue
   * #17). `connection` starts with an empty `frames` array — frame data
   * arrives via subsequent `wsFrame` messages sharing the same `id`.
   */
  | { type: 'wsOpen'; connection: CapturedWebSocketConnection }
  /** A WebSocket frame was relayed — `connection` is the full up-to-date record (see `DetourEvents['wsFrame']`'s doc comment), not just the new frame. */
  | { type: 'wsFrame'; connection: CapturedWebSocketConnection }
  /** A proxied WebSocket connection closed, cleanly or via error. */
  | { type: 'wsClose'; connection: CapturedWebSocketConnection }
  /**
   * The currently active rules.json contents (issue #19's Rules editor) —
   * sent once right after connecting and again after every reload, whether
   * triggered by a `setRules`/`applyRuleProfile` edit from the dashboard or
   * an external hand-edit of the file. `null` when this session has no
   * rules file configured (`detour start` without `--rules`, and no
   * `rules.json` auto-detected in the working directory).
   *
   * `unreachableWarnings`/`scriptWarnings` reflect this same `data` (empty
   * when `data` is `null`) — see `findUnreachableRules`'s/
   * `findDisabledScriptWarnings`'s doc comments for what's actually
   * detected. Both are computed against the last-*saved* file, not whatever
   * unsaved edits the Rules editor's own draft state might currently hold.
   */
  | {
      type: 'rules';
      data: RulesFile | null;
      unreachableWarnings: UnreachableRuleWarning[];
      scriptWarnings: ScriptGateWarning[];
    }
  /**
   * The saved rule profiles available to switch to or apply (issue #19's
   * Rules Profiles) — sent once right after connecting and again after any
   * profile is created or overwritten.
   */
  | { type: 'ruleProfiles'; profiles: RuleProfileSummary[] }
  /**
   * The current persistent `detour start` defaults (see `UserConfigState`) —
   * sent once right after connecting and again after every `setUserConfig`
   * (whether from this client or another connected tab).
   */
  | { type: 'userConfig'; state: UserConfigState }
  /**
   * JSON descriptor of the `--proto` schema loaded for this session (issue
   * #18's gRPC decoding, extended to the dashboard) — `protobufjs`'s
   * `Root.toJSON()` output, which the browser reconstructs client-side via
   * `protobufjs/light`'s `Root.fromJSON()` to decode a gRPC exchange's
   * message frames in the Body tab, the same way the CLI's `--dump full`
   * already does server-side (see `infra/grpc/grpcExchangeInfo.ts`). `null`
   * when no `--proto` was given for this session. Sent once, right after
   * connecting — unlike `rules`, there's no live-reload: a `.proto` schema
   * is fixed for the process's whole lifetime.
   */
  | { type: 'protoSchema'; schema: Record<string, unknown> | null }
  /**
   * Sent once, right after connecting (issue #144): whether this session
   * was started with `--persist`, i.e. whether `queryHistory` will ever
   * return anything. Lets the dashboard hide the History feature entirely
   * rather than offering a control that always comes back empty.
   */
  | { type: 'historyStatus'; enabled: boolean }
  /**
   * Answers a `queryHistory` request (issue #144) with one page of
   * persisted exchanges, newest-first. `requestId` echoes the request so a
   * client that fired a new query before an earlier one's answer arrived
   * can tell which is which and discard the stale one. Sent directly to
   * the requesting socket only — unlike every other message here, this
   * isn't broadcast to every connected tab, since it answers one tab's own
   * query rather than reflecting shared server state.
   */
  | { type: 'historyResult'; requestId: string; items: CapturedExchange[]; hasMore: boolean };

/**
 * Messages sent from a connected browser client to the dashboard server over
 * the `/ws` WebSocket. This is the one place traffic flows browser → server
 * — every other message type is server → browser only.
 */
export type DashboardClientMessage =
  /**
   * Answers an `authRequired` message (issue #66's optional dashboard
   * password) with the password the user typed. The server replies with
   * either the normal just-connected snapshot (success — same messages any
   * client gets right after connecting when no password is required) or
   * `authFailed` (wrong password; the socket stays unauthenticated and this
   * can be retried). Sending anything else before authenticating is ignored.
   */
  | { type: 'login'; password: string }
  /** Resumes (optionally with edits) or aborts an exchange paused by a `breakpoint` rule. */
  | { type: 'breakpointResume'; command: BreakpointResumeCommand }
  /** Turns interception on/off (see `InterceptState`). */
  | { type: 'setIntercept'; enabled: boolean }
  /** Replaces the Focus host allowlist wholesale (see `FocusState`). */
  | { type: 'setFocus'; hosts: string[] }
  /** Replaces the Throttle profile wholesale (see `ThrottleState`). */
  | { type: 'setThrottle'; state: ThrottleState }
  /** Replaces the Block Hosts denylist wholesale (see `BlockHostsState`). */
  | { type: 'setBlockHosts'; state: BlockHostsState }
  /**
   * Saves edits to the currently active rules.json (issue #19's Rules
   * editor). Rejected — via an `error` broadcast — if `data` fails
   * validation or no rules file is configured for this session.
   */
  | { type: 'setRules'; data: RulesFile }
  /**
   * Creates a new saved rule profile (issue #19's Rules Profiles) seeded
   * from a template: `'blank'` (no rules) or `'sample'` (the same starter
   * set `detour rules init` scaffolds). Rejected if `name` is already
   * taken or invalid.
   */
  | { type: 'createRuleProfile'; name: string; template: 'blank' | 'sample' }
  /** Saves the currently active rules.json as a named profile, creating it or overwriting it if it already exists. */
  | { type: 'saveActiveRulesAsProfile'; name: string }
  /** Loads a saved profile's rules and writes them into the currently active rules.json — equivalent to pasting its contents into the Rules editor and saving. */
  | { type: 'applyRuleProfile'; name: string }
  /**
   * Re-sends a previously captured exchange for real (issue #19's Replay).
   * The dashboard sends the full exchange it already has rather than just
   * an id — the server has no independent way to look up an id that may
   * have already fallen out of its own backlog. The result appears as a
   * normal new `request`/`response` pair, not a dedicated message type.
   */
  | { type: 'replay'; exchange: CapturedExchange }
  /**
   * Persists a change to `~/.detour/config.json` (see `UserConfigState`) —
   * merged into the existing file the same way `detour config` does, so
   * setting one field never clobbers the other. Broadcast back to every
   * connected tab (via `userConfig`) once written, same as every other
   * `set*` message here.
   */
  | { type: 'setUserConfig'; state: Partial<UserConfigState> }
  /**
   * Sets or clears the dashboard password (issue #66) — `null` removes it.
   * Only meaningful from an already-authenticated socket (see `login`
   * above): a socket that hasn't authenticated yet has this ignored along
   * with every other message type. The server hashes `password` before
   * persisting it (never stored or logged in plaintext) and broadcasts the
   * updated `userConfig` (`dashboardPasswordSet`) to every connected tab.
   */
  | { type: 'setDashboardPassword'; password: string | null }
  /**
   * Requests one page of persisted exchange history (issue #144), answered
   * by a `historyResult` carrying the same `requestId`. Answered with an
   * empty, `hasMore: false` result (never dropped) when this session
   * wasn't started with `--persist` — a client is expected to check
   * `historyStatus` before ever sending this, but this keeps a stray query
   * from hanging forever waiting on a reply that would otherwise never come.
   */
  | { type: 'queryHistory'; requestId: string; query: HistoryQuery };
