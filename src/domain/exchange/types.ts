import type { IncomingHttpHeaders } from 'node:http';

/**
 * A single HTTP(S) request/response pair captured by the proxy.
 * This is the shape shared over the in-memory event bus, and later
 * (via the web dashboard) over the wire to consumers.
 */
export interface CapturedExchange {
  /** Unique id for this exchange, stable across the request/response lifecycle. */
  id: string;
  method: string;
  /** Fully-qualified URL, e.g. https://example.com/path?x=1 */
  url: string;
  host: string;
  isSSL: boolean;
  /**
   * The protocol version negotiated with the client for this exchange
   * (issue #16) — `'HTTP/2'` when the client ALPN-negotiated h2 against the
   * MITM'd TLS server (only possible when `listen.http2` is enabled; see
   * `ProxyServerOptions.http2Enabled`), `'HTTP/1.1'` otherwise. The
   * proxy→upstream leg is always HTTP/1.1 regardless of this value — only
   * the client-facing side can differ.
   */
  protocol: 'HTTP/1.1' | 'HTTP/2';
  requestHeaders: IncomingHttpHeaders;
  requestBodySize: number;
  /**
   * Captured request body, base64-encoded, capped at `MAX_CAPTURED_BODY_BYTES`
   * (see proxyServer.ts). Undefined when the body was empty or hasn't been
   * captured yet (e.g. a `request` event fired before the body finished).
   */
  requestBody?: string;
  /** True when `requestBodySize` exceeds what was actually captured in `requestBody`. */
  requestBodyTruncated?: boolean;
  startedAt: number;

  statusCode?: number;
  statusMessage?: string;
  responseHeaders?: IncomingHttpHeaders;
  responseBodySize: number;
  /** Captured response body, base64-encoded and capped — see `requestBody`. */
  responseBody?: string;
  /** True when `responseBodySize` exceeds what was actually captured in `responseBody`. */
  responseBodyTruncated?: boolean;
  finishedAt?: number;
  durationMs?: number;

  error?: string;
  /** Name of the rules.json rule that handled this exchange, if any. */
  ruleName?: string;
  /**
   * Set only on the transient snapshot broadcast alongside a `breakpoint`
   * dashboard message: which phase this exchange is currently paused at,
   * awaiting the dashboard's edit/resume. Cleared (absent) on the next
   * `request`/`response` update once it's resumed or aborted — this field
   * is not part of an exchange's persisted state.
   */
  breakpoint?: 'request' | 'response';
  /**
   * True for a raw TLS passthrough tunnel (Intercept off, or a host outside
   * Focus — see `InterceptState`/`FocusState`'s doc comments), recorded so
   * the dashboard shows at least *where* passthrough traffic went even
   * though its contents are never decrypted. Every field here beyond the
   * identifying/timing ones (`id`, `method` — always `'CONNECT'` —, `url`,
   * `host`, `isSSL`, `startedAt`, `finishedAt`, `durationMs`, `error`) is a
   * meaningless placeholder (empty headers, zero body sizes, no
   * `statusCode`) rather than real captured data; this flag is what tells a
   * consumer that's the case instead of it misreading them as an empty
   * decrypted exchange. Absent (not merely `false`) on every other exchange.
   */
  passthrough?: true;
}

/**
 * A single WebSocket frame captured while a proxied `ws://`/`wss://`
 * connection is open (issue #17). `type` mirrors the `ws` library's own
 * event names — `message` carries the application payload, `ping`/`pong`
 * are keepalive frames.
 */
export interface WebSocketFrameRecord {
  type: 'message' | 'ping' | 'pong';
  /** Which leg this frame traveled: client→proxy (relayed on to the server) or server→proxy (relayed on to the client). */
  direction: 'toServer' | 'toClient';
  /** True for a binary `message` frame; always false for `ping`/`pong` (their payload, if any, is just a control-frame body, not application data). */
  binary: boolean;
  /** Original payload size in bytes, even when `data` below was capped or omitted. */
  size: number;
  at: number;
  /** Captured payload, base64-encoded and capped the same way as `CapturedExchange` bodies. Undefined when the frame was empty. */
  data?: string;
  /** True when `size` exceeds what was actually captured in `data`. */
  truncated?: boolean;
}

/**
 * A WebSocket connection tunneled through the proxy (issue #17): the
 * upgrade handshake, every frame exchanged, and how it eventually closed.
 * Kept alongside (not merged into) `CapturedExchange`, since a WS
 * connection's shape — a long-lived stream of frames rather than one
 * request/response pair — doesn't fit that type's fields.
 */
export interface CapturedWebSocketConnection {
  /** Unique id for this connection, stable across its whole lifecycle. */
  id: string;
  /** Fully-qualified URL, e.g. wss://example.com/socket */
  url: string;
  host: string;
  isSSL: boolean;
  /** The upgrade request's headers, minus `sec-websocket-*` (handshake noise, not application data). */
  requestHeaders: IncomingHttpHeaders;
  openedAt: number;
  /** Captured frames, capped at `MAX_CAPTURED_WS_FRAMES` — see `framesTruncated`. */
  frames: WebSocketFrameRecord[];
  /** Total frames seen so far, even beyond what's retained in `frames`. */
  frameCount: number;
  /** True once `frames` has hit its cap and older frames are evicted to make room for new ones. */
  framesTruncated: boolean;
  closedAt?: number;
  durationMs?: number;
  closeCode?: number;
  closeReason?: string;
  /** True when the upstream server closed first; false when the client did. Undefined if the connection ended via `error` before either side closed cleanly. */
  closedByServer?: boolean;
  error?: string;
}

export interface ProxyErrorEvent {
  id?: string;
  errorKind: string;
  message: string;
}

export interface RulesReloadEvent {
  filePath: string;
  ruleCount: number;
}

/** A paused request, awaiting the dashboard's edit/resume. Headers/body reflect what the client actually sent. */
export interface BreakpointRequestPayload {
  phase: 'request';
  id: string;
  method: string;
  /** Path + query string only (no scheme/host) — the same shape `rewrite.request.query` operates on. */
  path: string;
  headers: Record<string, string>;
  /** Base64-encoded, capped the same way as `CapturedExchange.requestBody`. Undefined when the body was empty. */
  body?: string;
  bodyTruncated: boolean;
}

/** A paused response, awaiting the dashboard's edit/resume. Status/headers/body reflect what upstream actually sent. */
export interface BreakpointResponsePayload {
  phase: 'response';
  id: string;
  status: number;
  statusMessage?: string;
  headers: Record<string, string>;
  /** Base64-encoded, capped the same way as `CapturedExchange.responseBody`. Undefined when the body was empty. */
  body?: string;
  bodyTruncated: boolean;
}

export type BreakpointPayload = BreakpointRequestPayload | BreakpointResponsePayload;

/** Edits to apply to a paused request before it's forwarded. Omitted fields keep their captured value. */
export interface BreakpointRequestEdits {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  /** Base64. Omit to send the original, unedited body. */
  body?: string;
}

/** Edits to apply to a paused response before it's returned to the client. Omitted fields keep their captured value. */
export interface BreakpointResponseEdits {
  status?: number;
  statusMessage?: string;
  headers?: Record<string, string>;
  /** Base64. Omit to send the original, unedited body. */
  body?: string;
}

/**
 * Sent by the dashboard to resume (optionally with edits) or abort a paused
 * exchange. `abort` is split by phase too (rather than `phase: 'request' |
 * 'response'`) purely so `Extract<BreakpointResumeCommand, {phase: 'request'}>`
 * (used to type each phase's wait) picks it up along with its `resume` sibling.
 */
export type BreakpointResumeCommand =
  | { id: string; phase: 'request'; action: 'resume'; edits?: BreakpointRequestEdits }
  | { id: string; phase: 'request'; action: 'abort' }
  | { id: string; phase: 'response'; action: 'resume'; edits?: BreakpointResponseEdits }
  | { id: string; phase: 'response'; action: 'abort' };

/**
 * Whether the proxy is actively intercepting traffic. `enabled: false` means:
 * HTTPS is a raw TLS passthrough (no MITM decryption — the client sees the
 * real upstream certificate, and its contents are never observable, though
 * it still shows up as a `passthrough` exchange recording just the
 * destination and timing — see `CapturedExchange.passthrough`), and mock/
 * rewrite/breakpoint rules are skipped for plain HTTP. A `route` rule keeps
 * applying either way, for both HTTP and (host-only, since the tunnel is
 * never decrypted) HTTPS.
 */
export interface InterceptState {
  enabled: boolean;
}

/**
 * The "Focus" host allowlist. Empty (the default) means unrestricted — every
 * host is intercepted, exactly as if Focus didn't exist. When non-empty,
 * only a host matching one of these `*`/`?` glob patterns is
 * MITM-decrypted/intercepted; every other host is treated as if intercept
 * were off for it alone (HTTPS is a raw TLS passthrough, mock/rewrite/
 * breakpoint rules are skipped for plain HTTP). A `route` rule keeps
 * applying regardless of focus, same as `InterceptState`. A pattern is
 * matched against `host`, or `host:port` when the request's port isn't its
 * scheme's default (443 for HTTPS, 80 for plain HTTP) — e.g. `*.example.com`
 * or `localhost:3000`.
 */
export interface FocusState {
  hosts: string[];
}

/**
 * "Throttle" simulates degraded network conditions (bandwidth cap, latency,
 * packet loss) on proxied traffic, toggled at runtime from the dashboard.
 * `enabled: false` (the default) is a true no-op. `downKbps`/`upKbps` cap
 * response/request throughput in kilobits/sec (`0` = unlimited, per-exchange
 * — see `BandwidthState` in proxyServer.ts); `latencyMs` adds one-time delay
 * before an exchange starts forwarding; `packetLossPct` (0-100) is the
 * chance a transfer is held back by `RETRANSMIT_DELAY_MS` to approximate a
 * lost packet's retransmit stall, since bytes can't actually be dropped
 * without corrupting the body. See proxyServer.ts's onRequestEnd/
 * onResponseEnd for exactly what's covered (buffered MITM'd bodies, skipped
 * for mock/breakpoint/rewrite responses) vs. the raw CONNECT tunnel's
 * genuine chunk-by-chunk throttling.
 */
export interface ThrottleState {
  enabled: boolean;
  downKbps: number;
  upKbps: number;
  latencyMs: number;
  packetLossPct: number;
}

/**
 * The "Block Hosts" denylist: outright denies requests to matching hosts
 * instead of letting them reach Focus/Intercept or the rule engine, toggled
 * at runtime from the dashboard. Empty (the default) means nothing is
 * blocked — identical to this feature not existing. A pattern is matched
 * the same way as Focus (`*`/`?` glob against `host`, or `host:port` when
 * the request's port isn't its scheme's default). Checked before every
 * other feature, so a blocked host is denied unconditionally — even with
 * Intercept off or a `route` rule that would otherwise still apply.
 *
 * `mode` picks how a blocked request is denied: `'forbidden'` sends back an
 * HTTP 403 response (for a CONNECT tunnel, a 403 status line before the
 * tunnel is ever established); `'reset'` drops the connection immediately
 * instead, without ever sending a response — the same as a `mock` rule's
 * `simulate: 'close'`.
 */
export interface BlockHostsState {
  hosts: string[];
  mode: 'forbidden' | 'reset';
}

/** Events published on the in-memory event bus. */
export interface DetourEvents {
  /** Fired once the client finished sending the request (headers + body). */
  request: (exchange: Readonly<CapturedExchange>) => void;
  /** Fired once the upstream response finished streaming back to the client. */
  response: (exchange: Readonly<CapturedExchange>) => void;
  /** Fired on proxy-level errors (connection resets, TLS failures, etc), and when a rules.json reload fails. */
  error: (event: ProxyErrorEvent) => void;
  /** Fired whenever rules.json is (re)loaded successfully. */
  rulesReloaded: (event: RulesReloadEvent) => void;
  /**
   * A `breakpoint` rule paused an exchange, awaiting the dashboard's
   * edit/resume. `exchange` is a transient snapshot with `breakpoint` set
   * (see `CapturedExchange.breakpoint`) for table/row display; `payload`
   * carries the full editable content for the breakpoint editor.
   */
  breakpointHit: (event: { exchange: Readonly<CapturedExchange>; payload: BreakpointPayload }) => void;
  /** The dashboard resumed or aborted a paused exchange. */
  breakpointResume: (command: BreakpointResumeCommand) => void;
  /** The dashboard toggled interception on/off (see `InterceptState`). */
  setIntercept: (enabled: boolean) => void;
  /** The proxy applied an intercept on/off change; broadcast to dashboards so every connected tab (and newly-connecting ones) reflect the current state. */
  interceptChanged: (state: InterceptState) => void;
  /** The dashboard changed the "Focus" host allowlist (see `FocusState`). */
  setFocus: (hosts: string[]) => void;
  /** The proxy applied a focus change; broadcast to dashboards so every connected tab (and newly-connecting ones) reflect the current allowlist. */
  focusChanged: (state: FocusState) => void;
  /** The dashboard changed the Throttle profile (see `ThrottleState`). */
  setThrottle: (state: ThrottleState) => void;
  /** The proxy applied a throttle change; broadcast to dashboards so every connected tab (and newly-connecting ones) reflect the current profile. */
  throttleChanged: (state: ThrottleState) => void;
  /** The dashboard changed the "Block Hosts" denylist (see `BlockHostsState`). */
  setBlockHosts: (state: BlockHostsState) => void;
  /** The proxy applied a Block Hosts change; broadcast to dashboards so every connected tab (and newly-connecting ones) reflect the current denylist. */
  blockHostsChanged: (state: BlockHostsState) => void;
  /** A proxied WebSocket connection just completed its upgrade handshake (issue #17). */
  wsOpen: (connection: Readonly<CapturedWebSocketConnection>) => void;
  /** A WebSocket frame was relayed through the proxy — fired after `wsOpen`, potentially many times over a connection's life. Carries the full up-to-date connection (mirroring how `request`/`response` share `CapturedExchange`), not just the new frame. */
  wsFrame: (connection: Readonly<CapturedWebSocketConnection>) => void;
  /** A proxied WebSocket connection closed, cleanly or via error. */
  wsClose: (connection: Readonly<CapturedWebSocketConnection>) => void;
}
