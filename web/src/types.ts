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
}

export interface ProxyErrorEvent {
  id?: string;
  errorKind: string;
  message: string;
}

export type DashboardServerMessage =
  | { type: 'backlog'; items: CapturedExchange[] }
  | { type: 'request'; exchange: CapturedExchange }
  | { type: 'response'; exchange: CapturedExchange }
  | { type: 'error'; event: ProxyErrorEvent };
