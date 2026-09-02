import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface PillToggleProps {
  active: boolean;
  title: string;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}

/** Small pill-shaped trigger button shared by the header's Focus/Throttle popovers — accent-colored border/text when active, muted otherwise. */
export function PillToggle({ active, title, onClick, icon, children }: PillToggleProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
        active ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--muted)] text-[var(--muted)]',
      )}
    >
      {icon}
      {children}
    </button>
  );
}
