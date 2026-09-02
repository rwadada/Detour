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

/**
 * Messages sent from the dashboard server to a connected browser client over
 * the `/ws` WebSocket. Kept in one place so the wire format has a single
 * source of truth; the frontend (web/src/lib/protocol.ts) mirrors this shape
 * by hand since it's built as a separate, standalone package.
 */
export type DashboardServerMessage =
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
  | { type: 'wsClose'; connection: CapturedWebSocketConnection };

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
  | { type: 'setBlockHosts'; state: BlockHostsState };
