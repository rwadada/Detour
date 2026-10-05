import type { CapturedExchange, WireExchange } from '../exchange/types';
import { fromWireExchange, toWireExchange } from '../exchange/wireExchange';

/** A snapshot older than this is ignored: it was left behind by an update that never got as far as relaunching. */
export const BACKLOG_SNAPSHOT_TTL_MS = 10 * 60 * 1000;

const SNAPSHOT_VERSION = 1;

interface BacklogSnapshotFile {
  version: typeof SNAPSHOT_VERSION;
  savedAt: number;
  items: WireExchange[];
}

/**
 * Only finished exchanges survive a restart: an in-flight one lost its
 * connection with the old process and would sit as "pending" forever, and
 * a breakpoint-paused one can no longer be resumed.
 */
function isResumable(exchange: CapturedExchange): boolean {
  return exchange.finishedAt !== undefined || exchange.error !== undefined;
}

export function serializeBacklogSnapshot(items: readonly CapturedExchange[], now: number): string {
  const file: BacklogSnapshotFile = {
    version: SNAPSHOT_VERSION,
    savedAt: now,
    items: items.filter(isResumable).map((item) => {
      const wire = toWireExchange(item);
      delete wire.breakpoint;
      return wire;
    }),
  };
  return JSON.stringify(file);
}

function isWireExchangeLike(value: unknown): value is WireExchange {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const { requestHeaders } = candidate;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.method === 'string' &&
    typeof candidate.url === 'string' &&
    typeof candidate.host === 'string' &&
    typeof candidate.startedAt === 'number' &&
    typeof requestHeaders === 'object' &&
    requestHeaders !== null &&
    !Array.isArray(requestHeaders)
  );
}

/** The exchanges to preload, or an empty list for anything stale, malformed, or from an unknown format version. */
export function parseBacklogSnapshot(text: string, now: number): CapturedExchange[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const file = parsed as Partial<BacklogSnapshotFile>;
  if (file.version !== SNAPSHOT_VERSION || typeof file.savedAt !== 'number' || !Array.isArray(file.items)) return [];
  const age = now - file.savedAt;
  if (age < 0 || age > BACKLOG_SNAPSHOT_TTL_MS) return [];
  return file.items.filter(isWireExchangeLike).map(fromWireExchange);
}
