import { X } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { cn } from '../lib/utils';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

/**
 * A generic centered modal dialog — Escape or clicking the backdrop closes
 * it. Added for the Rules editor (issue #19), which needs more room than
 * the header popovers (`ThrottleControl`, `FocusControl`, …) give.
 */
export function Dialog({ open, onClose, title, children, className }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is already handled above; this backdrop only needs pointer dismissal.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-xl',
          className,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--muted)] hover:bg-[var(--row-hover)]"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}
