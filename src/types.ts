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
 * real upstream certificate, and no exchange is observable), and mock/
 * rewrite/breakpoint rules are skipped for plain HTTP. A `route` rule keeps
 * applying either way, for both HTTP and (host-only, since the tunnel is
 * never decrypted) HTTPS.
 */
export interface InterceptState {
  enabled: boolean;
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
}
