import { Upload } from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';
import { parseImportedLog, useExchangeStore } from '@/entities/exchange';
import { Button } from '@/shared/ui';

/**
 * Header control for the LogViewer (issue #19): loads a saved HAR/JSON log
 * file and shows it in the log table without a running proxy. Parsing
 * happens entirely client-side (`parseImportedLog`) — nothing is sent to
 * the server.
 */
export function ImportButton() {
  const importExchanges = useExchangeStore((s) => s.importExchanges);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-selecting the same file after an error
    if (!file) return;
    try {
      const exchanges = parseImportedLog(await file.text());
      importExchanges(exchanges, file.name);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import this file.');
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="file"
        accept=".har,.json,application/json"
        className="hidden"
        onChange={handleChange}
      />
      <Button
        variant="ghost"
        size="icon"
        onClick={() => inputRef.current?.click()}
        title="Import a saved HAR or JSON log — view it without a running proxy"
      >
        <Upload className="h-3.5 w-3.5" />
      </Button>
      {error && (
        <div
          role="alert"
          className="absolute right-0 top-full z-10 mt-2 w-64 rounded-md border border-[var(--status-5xx)] bg-[var(--panel)] p-2 text-xs text-[var(--status-5xx)] shadow-lg"
        >
          {error}
        </div>
      )}
    </div>
  );
}
