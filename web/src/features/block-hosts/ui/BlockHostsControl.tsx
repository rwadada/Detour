import { Ban } from 'lucide-react';
import { useRef, useState } from 'react';
import { useBlockHostsStore } from '@/entities/proxy-config';
import type { BlockHostsState } from '@/shared/api';
import { useDismissablePopover } from '@/shared/lib/useDismissablePopover';
import { HostChipList, PillToggle, Select } from '@/shared/ui';

const MODE_LABEL: Record<BlockHostsState['mode'], string> = {
  forbidden: '403 Forbidden',
  reset: 'Connection reset',
};

/**
 * Header control for the "Block Hosts" denylist (issue #14): outright denies
 * requests to a set of `*`/`?` glob host patterns, either with a 403
 * response or by resetting the connection. Mirrors FocusControl's popover
 * pattern (a button that opens a small editable panel), plus a mode select
 * for how a blocked request is denied.
 */
export function BlockHostsControl() {
  const blockHosts = useBlockHostsStore((s) => s.blockHosts);
  const setBlockHosts = useBlockHostsStore((s) => s.setBlockHosts);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useDismissablePopover(open, containerRef, () => setOpen(false));

  const setHosts = (hosts: string[]) => setBlockHosts({ ...blockHosts, hosts });

  const active = blockHosts.hosts.length > 0;

  return (
    <div className="relative" ref={containerRef}>
      <PillToggle
        active={active}
        onClick={() => setOpen((v) => !v)}
        icon={<Ban className="h-3 w-3" />}
        title={
          active
            ? `Block Hosts is on — denying (${MODE_LABEL[blockHosts.mode]}) requests to: ${blockHosts.hosts.join(', ')}`
            : 'Block Hosts is off — click to deny requests to specific hosts'
        }
      >
        {active ? `Block (${blockHosts.hosts.length})` : 'Block: None'}
      </PillToggle>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-64 rounded-md border border-[var(--border)] bg-[var(--panel)] p-2.5 shadow-lg">
          <p className="mb-2 text-xs text-[var(--muted)]">
            Deny requests to hosts matching one of these patterns (<code className="font-mono-ui">*</code>/
            <code className="font-mono-ui">?</code> wildcards, e.g. <code className="font-mono-ui">*.example.com</code>
            ). Empty means nothing is blocked.
          </p>
          <Select
            value={blockHosts.mode}
            onChange={(e) => setBlockHosts({ ...blockHosts, mode: e.target.value as BlockHostsState['mode'] })}
            className="mb-2 w-full"
          >
            <option value="forbidden">403 Forbidden</option>
            <option value="reset">Connection reset</option>
          </Select>
          <HostChipList
            hosts={blockHosts.hosts}
            onChange={setHosts}
            placeholder="api.example.com"
            featureLabel="Block Hosts"
          />
        </div>
      )}
    </div>
  );
}
