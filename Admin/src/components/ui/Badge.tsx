import type { ReactNode } from 'react';

import { cn } from '../../utils/cn';

export type BadgeVariant = 'green' | 'red' | 'amber' | 'blue' | 'slate' | 'purple';

const variants: Record<BadgeVariant, string> = {
  green: 'bg-green-100 text-green-700',
  red: 'bg-red-100 text-red-700',
  amber: 'bg-amber-100 text-amber-700',
  blue: 'bg-blue-100 text-blue-700',
  slate: 'bg-slate-100 text-slate-600',
  purple: 'bg-purple-100 text-purple-700',
};

type BadgeProps = {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
};

export function Badge({ children, variant = 'slate', className }: BadgeProps) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', variants[variant], className)}>{children}</span>;
}
