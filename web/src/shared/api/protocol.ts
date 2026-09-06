/**
 * Mirrors `src/types.ts` (`CapturedExchange`) and `src/dashboard/protocol.ts`
 * (`DashboardServerMessage`) on the backend. Duplicated by hand rather than
 * imported across the package boundary — the dashboard builds standalone
 * with Vite and isn't set up with TS project references into the CLI
 * package. Keep this in sync when the wire format changes.
 */
/** A Node-style headers object (values may be a string or multi-value string array, e.g. `set-cookie`). */
export type HeaderMap = Record<string, string | string[] | undefined>;

export interface CapturedExchange {
  id: string;
  method: string;
  url: string;
  host: string;
  isSSL: boolean;
  /** See `src/domain/exchange/types.ts`'s `CapturedExchange.protocol` (issue #16). */
  protocol: 'HTTP/1.1' | 'HTTP/2';
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

  error?: string;
  ruleName?: string;
  /** Set only on the transient snapshot sent alongside a `breakpoint` message: which phase this exchange is currently paused at. Cleared on the next `request`/`response` update once resumed/aborted. */
  breakpoint?: 'request' | 'response';
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
  request?: { query?: QueryRewrite; headers?: HeaderRewrite; body?: BodyRewrite };
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
  rules: Rule[];
}

/** Mirrors `src/domain/rules/profile.ts`'s `RuleProfileSummary` (issue #19's Rules Profiles). */
export interface RuleProfileSummary {
  name: string;
  ruleCount: number;
  updatedAt: number;
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
  /** Sent once, right after connecting: the proxy port this dashboard session is fronting (issue #24's sidebar Proxy URL / QR code). */
  | { type: 'proxyInfo'; proxyPort: number }
  /** Sent once, right after connecting (issue #66): every LAN address this machine has — the proxy always binds to every interface, so this is non-empty regardless of `--lan`/`lanAccess`. `dashboardOnLan` says whether the dashboard is *also* bound to every interface right now (only then does a Dashboard URL, not just a Proxy one, make sense for each address). Powers the sidebar's LAN Access section. */
  | { type: 'lanInfo'; addresses: string[]; dashboardOnLan: boolean }
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
  /** The currently active rules.json contents — `null` when no rules file is configured for this session. */
  | { type: 'rules'; data: RulesFile | null }
  /** The saved rule profiles available to switch to or apply. */
  | { type: 'ruleProfiles'; profiles: RuleProfileSummary[] }
  /** The current persistent `detour start` defaults — sent once on connect and again after every `setUserConfig`. */
  | { type: 'userConfig'; state: UserConfigState };

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
  | { type: 'setDashboardPassword'; password: string | null };
