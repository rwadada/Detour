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
import type { RulesFile } from '../rules/types';

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
  /** Whether `detour start` binds the proxy and dashboard to every network interface (`0.0.0.0`) instead of just `localhost` — `detour config --lan`. Security-sensitive: LAN access has no authentication of its own, so anything on the network can reach the dashboard (and, from there, decrypted HTTPS traffic and rule edits) or use the proxy. */
  lanAccess: boolean;
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
   */
  | { type: 'proxyInfo'; proxyPort: number }
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
   */
  | { type: 'rules'; data: RulesFile | null }
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
  | { type: 'userConfig'; state: UserConfigState };

/**
 * Messages sent from a connected browser client to the dashboard server over
 * the `/ws` WebSocket. This is the one place traffic flows browser → server
 * — every other message type is server → browser only.
 */
export type DashboardClientMessage =
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
  | { type: 'setUserConfig'; state: Partial<UserConfigState> };
