import type { ReactNode } from 'react';

import { cn } from '../../utils/cn';

type CardProps = {
  children: ReactNode;
  className?: string;
};

export function Card({ children, className }: CardProps) {
  return <section className={cn('overflow-hidden rounded-xl border border-gray-200 bg-white', className)}>{children}</section>;
}

export function CardHeader({ children, className }: CardProps) {
  return <div className={cn('flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3.5', className)}>{children}</div>;
}
