import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Badge({
  className,
  style,
  title,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      style={style}
      title={title}
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold font-mono-ui',
        className,
      )}
    >
      {children}
    </span>
  );
}
