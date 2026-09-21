/**
 * Mirrors `src/types.ts` (`CapturedExchange`) and `src/dashboard/protocol.ts`
 * (`DashboardServerMessage`) on the backend. Duplicated by hand rather than
 * imported across the package boundary — the dashboard builds standalone
 * with Vite and isn't set up with TS project references into the CLI
 * package. Keep this in sync when the wire format changes.
 */
/** A Node-style headers object (values may be a string or multi-value string array, e.g. `set-cookie`). */
export type HeaderMap = Record<string, string | string[] | undefined>;

/** Mirrors `src/domain/exchange/types.ts`'s `ExchangeTiming` (issues #140, #162). */
export interface ExchangeTiming {
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  transferMs?: number;
  connectionReused?: boolean;
}

/** Mirrors `src/domain/exchange/types.ts`'s `ClientProcessInfo` (issue #147). */
export interface ClientProcessInfo {
  pid: number;
  name: string;
}

/** Mirrors `src/domain/exchange/types.ts`'s `UpstreamCertificate` (issue #160). */
export interface UpstreamCertificate {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  subjectAltName?: string;
  fingerprint256: string;
  authorized: boolean;
  authorizationError?: string;
  fromReusedConnection?: boolean;
}

export interface CapturedExchange {
  id: string;
  method: string;
  url: string;
  host: string;
  isSSL: boolean;
  /** See `src/domain/exchange/types.ts`'s `CapturedExchange.protocol` (issue #16). */
  protocol: 'HTTP/1.1' | 'HTTP/2';
  /** Which protocol the proxy→upstream leg actually spoke (issue #166) — see `src/domain/exchange/types.ts`'s `CapturedExchange.upstreamProtocol`. Independent of `protocol` above. */
  upstreamProtocol?: 'HTTP/1.1' | 'HTTP/2';
  requestHeaders: HeaderMap;
  requestBodySize: number;
  requestBody?: string;
  requestBodyTruncated?: boolean;
  startedAt: number;

  statusCode?: number;
  statusMessage?: string;
  responseHeaders?: HeaderMap;
  responseBodySize: number;
  responseBody?: string;
  responseBodyTruncated?: boolean;
  finishedAt?: number;
  durationMs?: number;
  timing?: ExchangeTiming;
  /** The upstream server's real TLS certificate (issue #160) — see `UpstreamCertificate`. Undefined for plain HTTP, and for HTTPS whose handshake never completed. */
  certificate?: UpstreamCertificate;
  /** The local process that sent this request, when known (issue #147, macOS-only) — see `src/domain/exchange/types.ts`'s `CapturedExchange.clientProcess`. */
  clientProcess?: ClientProcessInfo;

  error?: string;
  ruleName?: string;
  /** Set only on the transient snapshot sent alongside a `breakpoint` message: which phase this exchange is currently paused at. Cleared on the next `request`/`response` update once resumed/aborted. */
  breakpoint?: 'request' | 'response';
  /** A raw TLS passthrough tunnel (Intercept off / host outside Focus) rather than a decrypted exchange — see `src/domain/exchange/types.ts`'s `CapturedExchange.passthrough`. Every field beyond the identifying/timing ones is a meaningless placeholder when this is set. */
  passthrough?: true;
}

export interface ProxyErrorEvent {
  id?: string;
  errorKind: string;
  message: string;
}

export interface BreakpointRequestPayload {
  phase: 'request';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  bodyTruncated: boolean;
}

export interface BreakpointResponsePayload {
  phase: 'response';
  id: string;
  status: number;
  statusMessage?: string;
  headers: Record<string, string>;
  body?: string;
  bodyTruncated: boolean;
}

export type BreakpointPayload = BreakpointRequestPayload | BreakpointResponsePayload;

export interface BreakpointRequestEdits {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface BreakpointResponseEdits {
  status?: number;
  statusMessage?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type BreakpointResumeCommand =
  | { id: string; phase: 'request'; action: 'resume'; edits?: BreakpointRequestEdits }
  | { id: string; phase: 'request'; action: 'abort' }
  | { id: string; phase: 'response'; action: 'resume'; edits?: BreakpointResponseEdits }
  | { id: string; phase: 'response'; action: 'abort' };

/** Whether the proxy is actively intercepting traffic — see `src/types.ts`'s `InterceptState`. */
export interface InterceptState {
  enabled: boolean;
}

/** The current "Focus" host allowlist — see `src/types.ts`'s `FocusState`. */
export interface FocusState {
  hosts: string[];
}

/** The current "Throttle" network-simulation profile — see `src/types.ts`'s `ThrottleState`. */
export interface ThrottleState {
  enabled: boolean;
  downKbps: number;
  upKbps: number;
  latencyMs: number;
  packetLossPct: number;
}

/** The current "Block Hosts" denylist — see `src/types.ts`'s `BlockHostsState`. */
export interface BlockHostsState {
  hosts: string[];
  mode: 'forbidden' | 'reset';
}

/** A single captured WebSocket frame — see `src/domain/exchange/types.ts`'s `WebSocketFrameRecord` (issue #17). */
export interface WebSocketFrameRecord {
  type: 'message' | 'ping' | 'pong';
  direction: 'toServer' | 'toClient';
  binary: boolean;
  size: number;
  at: number;
  data?: string;
  truncated?: boolean;
}

/** A WebSocket connection tunneled through the proxy — see `src/domain/exchange/types.ts`'s `CapturedWebSocketConnection` (issue #17). */
export interface CapturedWebSocketConnection {
  id: string;
  url: string;
  host: string;
  isSSL: boolean;
  requestHeaders: HeaderMap;
  openedAt: number;
  frames: WebSocketFrameRecord[];
  frameCount: number;
  framesTruncated: boolean;
  closedAt?: number;
  durationMs?: number;
  closeCode?: number;
  closeReason?: string;
  closedByServer?: boolean;
  error?: string;
}

/** Mirrors `src/domain/rules/types.ts`'s `Rule`/`RulesFile` (issue #19's Rules editor). */
export interface RuleMatch {
  method?: string | string[];
  url?: string;
  urlRegex?: string;
  urlRegexFlags?: string;
}

export interface HeaderRewrite {
  set?: Record<string, string>;
  remove?: string[];
}

export interface QueryRewrite {
  set?: Record<string, string>;
  remove?: string[];
}

export interface BodyReplace {
  find: string;
  replacement: string;
  regex?: boolean;
  flags?: string;
}

export interface BodyRewrite {
  set?: unknown;
  replace?: BodyReplace[];
  merge?: unknown;
}

/** Rewrites a request URL's path — e.g. a path parameter like the `1` in `/users/1`. `query` only ever touches what comes after `?`. */
export interface PathRewrite {
  set?: string;
  replace?: BodyReplace[];
}

export interface MockAction {
  type: 'mock';
  status?: number;
  statusMessage?: string;
  headers?: Record<string, string>;
  body?: unknown;
  bodyFile?: string;
  delayMs?: number;
  simulate?: 'timeout' | 'close';
}

export interface RouteAction {
  type: 'route';
  host: string;
  port?: number;
  preserveHostHeader?: boolean;
}

export interface RewriteAction {
  type: 'rewrite';
  request?: { path?: PathRewrite; query?: QueryRewrite; headers?: HeaderRewrite; body?: BodyRewrite };
  response?: { status?: number; headers?: HeaderRewrite; body?: BodyRewrite };
}

export interface BreakpointAction {
  type: 'breakpoint';
  request?: boolean;
  response?: boolean;
}

export interface ScriptAction {
  type: 'script';
  path: string;
}

export type RuleAction = MockAction | RouteAction | RewriteAction | BreakpointAction | ScriptAction;

export interface Rule {
  name: string;
  enabled?: boolean;
  match: RuleMatch;
  action: RuleAction;
}

export interface RulesFile {
  $schema?: string;
  /** Best-effort marker of which saved rule profile was last applied/saved-as onto this content, if any — see `src/domain/rules/types.ts`'s `RulesFile.$activeProfile`. Not a guarantee the content still equals that profile's: reliably cleared by a Save from this dashboard's own Rules editor, but an external hand-edit that leaves the field alone keeps reporting it regardless of what actually changed. */
  $activeProfile?: string;
  rules: Rule[];
}

/** Mirrors `src/domain/rules/profile.ts`'s `RuleProfileSummary` (issue #19's Rules Profiles). */
export interface RuleProfileSummary {
  name: string;
  ruleCount: number;
  updatedAt: number;
}

/** Mirrors `src/domain/rules/unreachableRules.ts`'s `UnreachableRuleWarning` — a rule that can never run because an earlier `mock`/`route`/`breakpoint`/`script` rule already matches every request it would, and stops evaluation there first. */
export interface UnreachableRuleWarning {
  ruleName: string;
  ruleIndex: number;
  blockedByName: string;
  blockedByIndex: number;
  message: string;
}

/** Mirrors `src/domain/dashboard/protocol.ts`'s `HistoryFilters` (issue #144). Every field optional — omitted means "no restriction". */
export interface HistoryFilters {
  method?: string;
  host?: string;
  urlContains?: string;
  statusMin?: number;
  statusMax?: number;
}

/** Mirrors `src/domain/dashboard/protocol.ts`'s `HistoryQuery`. */
export interface HistoryQuery extends HistoryFilters {
  before?: number;
  /** Paired with `before` (a same-millisecond tie-breaker) — see the server-side `HistoryQuery`'s own doc comment. */
  beforeId?: string;
  limit: number;
}

/**
 * The persistent `detour start` defaults — see `src/domain/dashboard/protocol.ts`'s `UserConfigState`.
 * Both fields take effect on the *next* `detour start`, never this running instance.
 */
export interface UserConfigState {
  defaultDetach: boolean;
  lanAccess: boolean;
  /** Whether a dashboard password is currently required (issue #66) — never the hash/plaintext itself, just whether one is set. Takes effect immediately for new connections, unlike `defaultDetach`/`lanAccess` above. */
  dashboardPasswordSet: boolean;
}

export type DashboardServerMessage =
  /** Sent once, right after connecting: the proxy port this dashboard session is fronting (issue #24's sidebar Proxy URL / QR code). `insecureUpstream` (issue #160) is this session's `--insecure-upstream` setting, fixed for its whole lifetime — optional since an older server predating this field won't send it, in which case it's safe to read as `false` (that server build had no such flag to turn on). */
  | { type: 'proxyInfo'; proxyPort: number; insecureUpstream?: boolean }
  /** Sent once, right after connecting (issue #66): every LAN address this machine has — the proxy always binds to every interface, so this is non-empty regardless of `--lan`/`lanAccess`. `dashboardOnLan` says whether the dashboard is *also* bound to every interface right now (only then does a Dashboard URL, not just a Proxy one, make sense for each address) — optional since an older server predating that field won't send it (see `createProxyInfoStore`'s fallback for how that's handled). Powers the sidebar's LAN Access section. */
  | { type: 'lanInfo'; addresses: string[]; dashboardOnLan?: boolean }
  /** Sent instead of the usual just-connected snapshot when a dashboard password is configured and this socket hasn't supplied it yet (issue #66) — reply with `login`. Never sent at all when no password is configured. */
  | { type: 'authRequired' }
  /** A `login` message's password didn't match — still unauthenticated, can retry. */
  | { type: 'authFailed' }
  | { type: 'backlog'; items: CapturedExchange[] }
  | { type: 'wsBacklog'; items: CapturedWebSocketConnection[] }
  | { type: 'request'; exchange: CapturedExchange }
  | { type: 'response'; exchange: CapturedExchange }
  | { type: 'error'; event: ProxyErrorEvent }
  | { type: 'breakpoint'; exchange: CapturedExchange; payload: BreakpointPayload }
  | { type: 'intercept'; state: InterceptState }
  | { type: 'focus'; state: FocusState }
  | { type: 'throttle'; state: ThrottleState }
  | { type: 'blockHosts'; state: BlockHostsState }
  | { type: 'wsOpen'; connection: CapturedWebSocketConnection }
  | { type: 'wsFrame'; connection: CapturedWebSocketConnection }
  | { type: 'wsClose'; connection: CapturedWebSocketConnection }
  /** The currently active rules.json contents — `null` when no rules file is configured for this session. `unreachableWarnings` is computed against this same `data` (empty when it's `null`), not any unsaved Rules editor draft. */
  | { type: 'rules'; data: RulesFile | null; unreachableWarnings: UnreachableRuleWarning[] }
  /** The saved rule profiles available to switch to or apply. */
  | { type: 'ruleProfiles'; profiles: RuleProfileSummary[] }
  /** The current persistent `detour start` defaults — sent once on connect and again after every `setUserConfig`. */
  | { type: 'userConfig'; state: UserConfigState }
  /**
   * JSON descriptor of the `--proto` schema loaded for this session
   * (`protobufjs`'s `Root.toJSON()` output) — reconstructed client-side via
   * `protobufjs/light`'s `Root.fromJSON()` to decode a gRPC exchange's
   * message frames. `null` when no `--proto` was given. Sent once, right
   * after connecting — a `.proto` schema doesn't live-reload.
   */
  | { type: 'protoSchema'; schema: Record<string, unknown> | null }
  /** Sent once, right after connecting (issue #144): whether this session was started with `--persist` — lets the dashboard hide the History feature when it would always come back empty. */
  | { type: 'historyStatus'; enabled: boolean }
  /** Answers a `queryHistory` request (issue #144) with one page of persisted exchanges, newest-first. `requestId` echoes the request. Sent to the requesting socket only, never broadcast. */
  | { type: 'historyResult'; requestId: string; items: CapturedExchange[]; hasMore: boolean };

export type DashboardClientMessage =
  /** Answers an `authRequired` message with the password the user typed (issue #66). The server replies with either the normal just-connected snapshot (success) or `authFailed`. Ignored — like every other message type — before the socket has authenticated. */
  | { type: 'login'; password: string }
  | { type: 'breakpointResume'; command: BreakpointResumeCommand }
  | { type: 'setIntercept'; enabled: boolean }
  | { type: 'setFocus'; hosts: string[] }
  | { type: 'setThrottle'; state: ThrottleState }
  | { type: 'setBlockHosts'; state: BlockHostsState }
  /** Saves edits to the currently active rules.json (Rules editor). */
  | { type: 'setRules'; data: RulesFile }
  /** Creates a new saved rule profile from a template. */
  | { type: 'createRuleProfile'; name: string; template: 'blank' | 'sample' }
  /** Saves the currently active rules.json as a named profile. */
  | { type: 'saveActiveRulesAsProfile'; name: string }
  /** Loads a saved profile's rules into the currently active rules.json. */
  | { type: 'applyRuleProfile'; name: string }
  /** Re-sends a previously captured exchange for real (Replay). The result appears as a normal new `request`/`response` pair, not a dedicated message type. */
  | { type: 'replay'; exchange: CapturedExchange }
  /** Persists a change to `~/.detour/config.json`, merged into the existing file (setting one field never clobbers the other). */
  | { type: 'setUserConfig'; state: Partial<UserConfigState> }
  /** Sets (or, with `null`, clears) the dashboard password (issue #66). Only meaningful from an already-authenticated socket. */
  | { type: 'setDashboardPassword'; password: string | null }
  /** Requests one page of persisted exchange history (issue #144), answered by a `historyResult` carrying the same `requestId`. */
  | { type: 'queryHistory'; requestId: string; query: HistoryQuery };
