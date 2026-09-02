import { X } from 'lucide-react';
import { useState } from 'react';
import { Input } from './input';

export interface HostChipListProps {
  hosts: string[];
  onChange: (hosts: string[]) => void;
  placeholder: string;
  /** Feature name shown in each chip's "Remove X from …" title, e.g. "Focus" or "Block Hosts". */
  featureLabel: string;
}

/**
 * Small editable list of `*`/`?` host glob patterns: a text input that
 * appends a trimmed, deduped entry on Enter, plus a removable chip for each
 * entry already added. Shared by FocusControl's and BlockHostsControl's
 * popovers, which both edit a host-pattern list the same way.
 */
export function HostChipList({ hosts, onChange, placeholder, featureLabel }: HostChipListProps) {
  const [draft, setDraft] = useState('');

  const addHost = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (!hosts.includes(trimmed)) onChange([...hosts, trimmed]);
    setDraft('');
  };

  const removeHost = (host: string) => onChange(hosts.filter((h) => h !== host));

  return (
    <>
      {hosts.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {hosts.map((host) => (
            <button
              key={host}
              type="button"
              onClick={() => removeHost(host)}
              className="group inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 font-mono-ui text-[10px]"
              title={`Remove ${host} from ${featureLabel}`}
            >
              {host}
              <X className="h-2.5 w-2.5 opacity-60 group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addHost();
          }
        }}
        placeholder={placeholder}
        className="h-7 text-xs"
      />
    </>
  );
}
