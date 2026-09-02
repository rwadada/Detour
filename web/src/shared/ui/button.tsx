import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/shared/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
  {
    variants: {
      variant: {
        default: 'bg-[var(--accent)] text-[var(--accent-foreground)] hover:opacity-90',
        outline: 'border border-[var(--border)] bg-transparent hover:bg-[var(--row-hover)]',
        ghost: 'bg-transparent hover:bg-[var(--row-hover)]',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2 text-xs',
        icon: 'h-7 w-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';
