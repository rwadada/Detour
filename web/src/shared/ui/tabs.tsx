import type * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/shared/lib/utils';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        // `overflow-x-auto` (issue #160): once there are enough tabs to not
        // fit the panel's width (the Certificate tab was the one that first
        // pushed this over), a `<Tabs>` root left as the *implicit* scroll
        // container (via its own `overflow-hidden` — still a valid target
        // for the browser's focus-driven "scroll into view", even with no
        // visible scrollbar) shifts the whole panel, tab content included,
        // left when a tab near the edge is clicked/focused — not just the
        // tab strip. Giving the list its own scroll container instead
        // contains that scroll to the tab strip alone.
        'inline-flex h-8 items-center gap-1 overflow-x-auto border-b border-[var(--border)]',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'h-8 rounded-t-md border-b-2 border-transparent px-3 text-sm font-medium text-[var(--muted)] transition-colors',
        'hover:text-[var(--foreground)]',
        'data-[state=active]:border-[var(--accent)] data-[state=active]:text-[var(--foreground)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('flex-1 overflow-auto', className)} {...props} />;
}
