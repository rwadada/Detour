import * as React from 'react';
import { cn } from '@/lib/utils';

/** A plain native `<select>` styled to match the rest of the ui/ primitives — not worth pulling in Radix's Select for a handful of short option lists. */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'h-8 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 text-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';
