/**
 * Mirrors `src/types.ts` (`CapturedExchange`) and `src/dashboard/protocol.ts`
 * (`DashboardServerMessage`) on the backend. Duplicated by hand rather than
 * imported across the package boundary — the dashboard builds standalone
 * with Vite and isn't set up with TS project references into the CLI
 * package. Keep this in sync when the wire format changes.
 */
export interface CapturedExchange {
  id: string;
  method: string;
  url: string;
  host: string;
  isSSL: boolean;
  /** See `src/domain/exchange/types.ts`'s `CapturedExchange.protocol` (issue #16). */
  protocol: 'HTTP/1.1' | 'HTTP/2';
  requestHeaders: Record<string, string | string[] | undefined>;
  requestBodySize: number;
  requestBody?: string;
  requestBodyTruncated?: boolean;
  startedAt: number;

  statusCode?: number;
  statusMessage?: string;
  responseHeaders?: Record<string, string | string[] | undefined>;
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

export type DashboardServerMessage =
  | { type: 'backlog'; items: CapturedExchange[] }
  | { type: 'request'; exchange: CapturedExchange }
  | { type: 'response'; exchange: CapturedExchange }
  | { type: 'error'; event: ProxyErrorEvent }
  | { type: 'breakpoint'; exchange: CapturedExchange; payload: BreakpointPayload }
  | { type: 'intercept'; state: InterceptState }
  | { type: 'focus'; state: FocusState }
  | { type: 'throttle'; state: ThrottleState }
  | { type: 'blockHosts'; state: BlockHostsState };

export type DashboardClientMessage =
  | { type: 'breakpointResume'; command: BreakpointResumeCommand }
  | { type: 'setIntercept'; enabled: boolean }
  | { type: 'setFocus'; hosts: string[] }
  | { type: 'setThrottle'; state: ThrottleState }
  | { type: 'setBlockHosts'; state: BlockHostsState };
