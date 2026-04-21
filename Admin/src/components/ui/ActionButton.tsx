import type { ButtonHTMLAttributes } from 'react';

import { cn } from '../../utils/cn';

type ActionTone = 'indigo' | 'amber' | 'red' | 'green';

const tones: Record<ActionTone, string> = {
  indigo: 'text-indigo-600 hover:text-indigo-900',
  amber: 'text-amber-600 hover:text-amber-900',
  red: 'text-red-600 hover:text-red-900',
  green: 'text-green-600 hover:text-green-900',
};

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ActionTone;
};

export function ActionButton({ className, tone = 'indigo', type = 'button', ...props }: ActionButtonProps) {
  return <button {...props} type={type} className={cn('text-xs font-medium transition-colors', tones[tone], className)} />;
}

export function ActionDivider() {
  return <span className="mx-1 text-gray-300">|</span>;
}
