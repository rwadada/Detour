import { Target } from 'lucide-react';
import { useRef, useState } from 'react';
import { HostChipList, PillToggle } from '@/shared/ui';
import { useDismissablePopover } from '@/shared/lib/useDismissablePopover';
import { useFocusStore } from '../model/store';

/**
 * Header control for the "Focus" host allowlist (issue #12): restricts MITM
 * interception to a set of `*`/`?` glob host patterns instead of every host
 * the proxy sees. Mirrors the adjacent Intercept On/Off toggle's styling,
 * but needs a small editable list rather than a single boolean, so it's a
 * button that opens a dropdown panel instead of toggling directly.
 */
export function FocusControl() {
  const focusHosts = useFocusStore((s) => s.focusHosts);
  const setFocus = useFocusStore((s) => s.setFocus);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useDismissablePopover(open, containerRef, () => setOpen(false));

  const active = focusHosts.length > 0;

  return (
    <div className="relative" ref={containerRef}>
      <PillToggle
        active={active}
        onClick={() => setOpen((v) => !v)}
        icon={<Target className="h-3 w-3" />}
        title={
          active
            ? `Focus is on — MITM applies only to: ${focusHosts.join(', ')}`
            : 'Focus is off — every host is intercepted; click to restrict to specific hosts'
        }
      >
        {active ? `Focus (${focusHosts.length})` : 'Focus: All'}
      </PillToggle>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-64 rounded-md border border-[var(--border)] bg-[var(--panel)] p-2.5 shadow-lg">
          <p className="mb-2 text-xs text-[var(--muted)]">
            Only MITM-decrypt hosts matching one of these patterns (<code className="font-mono-ui">*</code>/
            <code className="font-mono-ui">?</code> wildcards, e.g. <code className="font-mono-ui">*.example.com</code>
            ). Empty means every host is intercepted. Add <code className="font-mono-ui">:port</code> to target a
            non-default port.
          </p>
          <HostChipList hosts={focusHosts} onChange={setFocus} placeholder="api.example.com" featureLabel="Focus" />
        </div>
      )}
    </div>
  );
}
