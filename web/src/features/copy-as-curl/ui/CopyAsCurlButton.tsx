import { Check, Terminal } from 'lucide-react';
import { useState } from 'react';
import type { CapturedExchange } from '@/shared/api';
import { Button } from '@/shared/ui';
import { buildCurlCommand } from '../model/curl';

/** Copies a captured exchange as a `curl` command (issue #19), shown in `InspectorPanel`. */
export function CopyAsCurlButton({ exchange }: { exchange: CapturedExchange }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(buildCurlCommand(exchange));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Button variant="ghost" size="icon" onClick={copy} title="Copy as curl">
      {copied ? <Check className="h-3.5 w-3.5 text-[var(--status-2xx)]" /> : <Terminal className="h-3.5 w-3.5" />}
    </Button>
  );
}
