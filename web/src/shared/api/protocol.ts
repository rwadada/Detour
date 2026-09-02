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

export type DashboardServerMessage =
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
  | { type: 'wsClose'; connection: CapturedWebSocketConnection };

export type DashboardClientMessage =
  | { type: 'breakpointResume'; command: BreakpointResumeCommand }
  | { type: 'setIntercept'; enabled: boolean }
  | { type: 'setFocus'; hosts: string[] }
  | { type: 'setThrottle'; state: ThrottleState }
  | { type: 'setBlockHosts'; state: BlockHostsState };
