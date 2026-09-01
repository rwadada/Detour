import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Badge({
  className,
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <span
      style={style}
      className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold font-mono-ui', className)}
    >
      {children}
    </span>
  );
}
