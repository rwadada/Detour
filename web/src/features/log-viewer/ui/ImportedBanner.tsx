import { useExchangeStore } from '@/entities/exchange';

/** Shown across the top of the app while the LogViewer (issue #19) is displaying an imported file instead of live traffic. */
export function ImportedBanner() {
  const source = useExchangeStore((s) => s.source);
  const fileName = useExchangeStore((s) => s.importedFileName);
  const count = useExchangeStore((s) => s.exchanges.length);
  const exitImport = useExchangeStore((s) => s.exitImport);

  if (source !== 'imported') return null;

  return (
    <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--accent)]/10 px-3 py-1.5 text-xs">
      <span className="text-[var(--foreground)]">
        Viewing imported log <strong className="font-semibold">{fileName}</strong> ({count} request
        {count === 1 ? '' : 's'}) — live capture is paused.
      </span>
      <button
        type="button"
        onClick={exitImport}
        className="shrink-0 rounded px-2 py-0.5 font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20"
      >
        Return to live
      </button>
    </div>
  );
}
