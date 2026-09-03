// `HarLog` is imported as a type only — never a runtime value — so this
// module has no runtime dependency on `@/entities/exchange`'s barrel, whose
// `useExchangeStore` singleton opens a real WebSocket as an import-time side
// effect (see ARCHITECTURE.md's "DashboardConnection pattern"). Building the
// actual `HarLog` (via `exchangesToHar`) is the caller's job — `ExportMenu`
// already depends on that barrel for `useExchangeStore` regardless.
import type { HarLog } from '@/entities/exchange';
import type { CapturedExchange } from '@/shared/api';

export type ExportFormat = 'har' | 'json';

/** Pretty-prints an already-built HAR 1.2 document (see `entities/exchange`'s `exchangesToHar`). */
export function serializeHar(har: HarLog): string {
  return JSON.stringify(har, null, 2);
}

/** Pretty-prints Detour's native JSON export — a plain `CapturedExchange[]`, re-importable by the LogViewer (`parseImportedLog`). */
export function serializeExchangesAsJson(exchanges: CapturedExchange[]): string {
  return JSON.stringify(exchanges, null, 2);
}

/** Timestamped filename, e.g. `detour-log-2026-09-03T12-00-00-000Z.har`. `when` is injectable for tests. */
export function exportFileName(format: ExportFormat, when: Date = new Date()): string {
  const stamp = when.toISOString().replace(/[:.]/g, '-');
  return `detour-log-${stamp}.${format}`;
}
