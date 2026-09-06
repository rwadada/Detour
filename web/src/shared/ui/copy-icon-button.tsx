import { Check, Copy } from 'lucide-react';
import { useCopyToClipboard } from '@/shared/lib/useCopyToClipboard';
import { Button } from './button';

/**
 * Small icon button that copies arbitrary text to the clipboard, flashing a
 * checkmark on success — the generic sibling of `copy-as-curl`'s
 * `CopyAsCurlButton` (issue #19). Backs `InspectorPanel`'s per-section copy
 * actions (issue #67): request/response headers and request/response body
 * are each copyable on their own now, rather than only reachable bundled
 * into a full curl command.
 */
export function CopyIconButton({
  getText,
  title,
  className,
}: {
  getText: () => string;
  title: string;
  className?: string;
}) {
  const { copied, copy } = useCopyToClipboard(getText);

  return (
    <Button variant="ghost" size="icon" onClick={copy} title={title} className={className}>
      {copied ? <Check className="h-3 w-3 text-[var(--status-2xx)]" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}
