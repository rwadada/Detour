import { Save } from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';
import { useExchangeStore } from '@/entities/exchange';
import { useBlockHostsStore, useFocusStore, useInterceptStore, useThrottleStore } from '@/entities/proxy-config';
import { downloadTextFile } from '@/shared/lib/downloadTextFile';
import { useDismissablePopover } from '@/shared/lib/useDismissablePopover';
import { Button } from '@/shared/ui';
import {
  buildSessionFile,
  parseSessionFile,
  serializeSessionFile,
  sessionFileName,
  SessionFileError,
} from '../model/sessionFile';

/**
 * Toolbar control for "Save / Session" (issue #24): unlike `features/log-
 * export`'s HAR/JSON export (just the traffic, for other tools or re-
 * viewing), a session also captures Intercept/Focus/Throttle/Block Hosts —
 * loading one both shows the saved traffic (via the existing "imported"
 * viewer mode) and reconfigures the live proxy to match, so resuming a
 * saved session actually resumes the environment it was captured under.
 */
export function SessionControl() {
  const exchanges = useExchangeStore((s) => s.exchanges);
  const filters = useExchangeStore((s) => s.filters);
  const importExchanges = useExchangeStore((s) => s.importExchanges);
  const setFilters = useExchangeStore((s) => s.setFilters);
  const interceptEnabled = useInterceptStore((s) => s.interceptEnabled);
  const setIntercept = useInterceptStore((s) => s.setIntercept);
  const focusHosts = useFocusStore((s) => s.focusHosts);
  const setFocus = useFocusStore((s) => s.setFocus);
  const throttle = useThrottleStore((s) => s.throttle);
  const setThrottle = useThrottleStore((s) => s.setThrottle);
  const blockHosts = useBlockHostsStore((s) => s.blockHosts);
  const setBlockHosts = useBlockHostsStore((s) => s.setBlockHosts);

  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDismissablePopover(open, containerRef, () => setOpen(false));

  const save = () => {
    const file = buildSessionFile({
      exchanges,
      filters,
      settings: {
        intercept: { enabled: interceptEnabled },
        focus: { hosts: focusHosts },
        throttle,
        blockHosts,
      },
    });
    downloadTextFile(sessionFileName(), serializeSessionFile(file));
    setOpen(false);
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-selecting the same file after an error
    setOpen(false);
    if (!file) return;
    try {
      const session = parseSessionFile(await file.text());
      importExchanges(session.exchanges, file.name);
      setFilters(session.filters);
      setIntercept(session.settings.intercept.enabled);
      setFocus(session.settings.focus.hosts);
      setThrottle(session.settings.throttle);
      setBlockHosts(session.settings.blockHosts);
      setError(null);
    } catch (err) {
      setError(err instanceof SessionFileError ? err.message : 'Failed to load this session file.');
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleFileChange}
      />
      <Button variant="ghost" size="icon" onClick={() => setOpen((v) => !v)} title="Save or load a session">
        <Save className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-48 rounded-md border border-[var(--border)] bg-[var(--panel)] p-1 shadow-lg">
          <button
            type="button"
            onClick={save}
            disabled={exchanges.length === 0}
            title={exchanges.length === 0 ? 'No captured requests to save' : undefined}
            className="block w-full rounded px-2 py-1.5 text-left text-xs text-[var(--foreground)] hover:bg-[var(--accent)]/10 disabled:pointer-events-none disabled:opacity-40"
          >
            Save session
          </button>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="block w-full rounded px-2 py-1.5 text-left text-xs text-[var(--foreground)] hover:bg-[var(--accent)]/10"
          >
            Load session…
          </button>
        </div>
      )}
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
