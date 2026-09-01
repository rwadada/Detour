import type { CapturedExchange, ProxyErrorEvent } from '../types';

/**
 * Messages sent from the dashboard server to a connected browser client over
 * the `/ws` WebSocket. Kept in one place so the wire format has a single
 * source of truth; the frontend (web/src/lib/protocol.ts) mirrors this shape
 * by hand since it's built as a separate, standalone package.
 */
export type DashboardServerMessage =
  /** Sent once, right after connecting: the recent-history backlog so a client that (re)connects mid-session isn't starting from a blank table. */
  | { type: 'backlog'; items: CapturedExchange[] }
  /** A request finished sending to the upstream server (may still be awaiting a response). */
  | { type: 'request'; exchange: CapturedExchange }
  /** A request/response exchange finished. */
  | { type: 'response'; exchange: CapturedExchange }
  /** A proxy-level error (connection reset, TLS failure, rules.json reload failure, etc). */
  | { type: 'error'; event: ProxyErrorEvent };
