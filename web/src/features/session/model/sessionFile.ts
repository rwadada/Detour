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

/**
 * Parses and validates a saved session file. Deliberately strict on
 * `detourSession` (see its doc comment) but otherwise only checks shape,
 * not exchange/state field-level correctness — a subtly-wrong `settings`
 * value just gets sent to the server as-is, which already validates its
 * own client messages.
 */
export function parseSessionFile(raw: string): DetourSessionFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new SessionFileError('Not valid JSON.');
  }
  if (typeof data !== 'object' || data === null) throw new SessionFileError('Not a Detour session file.');
  const file = data as Partial<DetourSessionFile>;
  if (file.detourSession !== SESSION_FILE_VERSION) {
    throw new SessionFileError(
      `Unsupported session file version (expected ${SESSION_FILE_VERSION}, got ${String(file.detourSession)}).`,
    );
  }
  if (!Array.isArray(file.exchanges)) throw new SessionFileError('Missing or invalid "exchanges".');
  if (typeof file.settings !== 'object' || file.settings === null) {
    throw new SessionFileError('Missing or invalid "settings".');
  }
  if (typeof file.filters !== 'object' || file.filters === null) {
    throw new SessionFileError('Missing or invalid "filters".');
  }
  return file as DetourSessionFile;
}
