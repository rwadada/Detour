import type { Filters } from '@/entities/exchange';
import type { BlockHostsState, CapturedExchange, FocusState, InterceptState, ThrottleState } from '@/shared/api';

/**
 * Bumped whenever `DetourSessionFile`'s shape changes in a way old files
 * can't be read as. `parseSessionFile` rejects anything with a different
 * value up front, rather than failing confusingly deeper in — e.g. missing
 * `settings.focus` reading as "Focus disabled" instead of "this file
 * predates that field".
 */
export const SESSION_FILE_VERSION = 1;

/**
 * The live-proxy toggles a session captures alongside its traffic (issue
 * #24's "Save / Session"). Rules aren't included here — `features/rules-
 * profiles` already owns saving/restoring rulesets, and a session mixing
 * both would just duplicate that.
 */
export interface SessionSettings {
  intercept: InterceptState;
  focus: FocusState;
  throttle: ThrottleState;
  blockHosts: BlockHostsState;
}

export interface DetourSessionFile {
  detourSession: number;
  savedAt: string;
  exchanges: CapturedExchange[];
  settings: SessionSettings;
  filters: Filters;
}

export function buildSessionFile(params: {
  exchanges: CapturedExchange[];
  settings: SessionSettings;
  filters: Filters;
  /** Injectable for tests; defaults to the real current time. */
  when?: Date;
}): DetourSessionFile {
  return {
    detourSession: SESSION_FILE_VERSION,
    savedAt: (params.when ?? new Date()).toISOString(),
    exchanges: params.exchanges,
    settings: params.settings,
    filters: params.filters,
  };
}

export function serializeSessionFile(file: DetourSessionFile): string {
  return JSON.stringify(file, null, 2);
}

/** Timestamped filename, e.g. `detour-session-2026-09-03T12-00-00-000Z.json`. `when` is injectable for tests. */
export function sessionFileName(when: Date = new Date()): string {
  const stamp = when.toISOString().replace(/[:.]/g, '-');
  return `detour-session-${stamp}.json`;
}

/** Thrown by `parseSessionFile` with a message specific enough to show the user directly (mirrors `parseImportedLog`'s error style). */
export class SessionFileError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validates just enough of `settings`'s nested shape that reading
 * `session.settings.intercept.enabled`, `.focus.hosts`, etc. (as
 * `SessionControl` does immediately after parsing, to apply them to the
 * live proxy) can't throw a raw, unhandled `TypeError` instead of this
 * function's own `SessionFileError` — field *values* (a host pattern with
 * odd characters, an out-of-range Kbps) aren't checked here, since those
 * reach the server as normal `set*` client messages that already validate
 * themselves.
 */
function assertValidSettings(settings: Record<string, unknown>): void {
  const { intercept, focus, throttle, blockHosts } = settings;
  if (!isRecord(intercept) || typeof intercept.enabled !== 'boolean') {
    throw new SessionFileError('Missing or invalid "settings.intercept".');
  }
  if (!isRecord(focus) || !Array.isArray(focus.hosts)) {
    throw new SessionFileError('Missing or invalid "settings.focus".');
  }
  if (
    !isRecord(throttle) ||
    typeof throttle.enabled !== 'boolean' ||
    typeof throttle.downKbps !== 'number' ||
    typeof throttle.upKbps !== 'number' ||
    typeof throttle.latencyMs !== 'number' ||
    typeof throttle.packetLossPct !== 'number'
  ) {
    throw new SessionFileError('Missing or invalid "settings.throttle".');
  }
  if (
    !isRecord(blockHosts) ||
    !Array.isArray(blockHosts.hosts) ||
    (blockHosts.mode !== 'forbidden' && blockHosts.mode !== 'reset')
  ) {
    throw new SessionFileError('Missing or invalid "settings.blockHosts".');
  }
}

/**
 * Parses and validates a saved session file. Deliberately strict on
 * `detourSession` (see its doc comment) and on `settings`'s nested shape
 * (see `assertValidSettings`) — everything else (individual exchange
 * fields, filter values) is only checked at the top level, since a
 * subtly-wrong value there just gets sent to the server as-is, which
 * already validates its own client messages.
 */
export function parseSessionFile(raw: string): DetourSessionFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new SessionFileError('Not valid JSON.');
  }
  if (!isRecord(data)) throw new SessionFileError('Not a Detour session file.');
  if (data.detourSession !== SESSION_FILE_VERSION) {
    throw new SessionFileError(
      `Unsupported session file version (expected ${SESSION_FILE_VERSION}, got ${String(data.detourSession)}).`,
    );
  }
  if (!Array.isArray(data.exchanges)) throw new SessionFileError('Missing or invalid "exchanges".');
  if (!isRecord(data.settings)) throw new SessionFileError('Missing or invalid "settings".');
  assertValidSettings(data.settings);
  if (!isRecord(data.filters)) throw new SessionFileError('Missing or invalid "filters".');
  return data as unknown as DetourSessionFile;
}
