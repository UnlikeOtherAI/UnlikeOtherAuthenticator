import type { ButtonHTMLAttributes } from 'react';

import { cn } from '../../utils/cn';

type SwitchTone = 'default' | 'danger';

type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  checked: boolean;
  label: string;
  tone?: SwitchTone;
};

export function Switch({ checked, className, label, tone = 'default', type = 'button', ...props }: SwitchProps) {
  const activeClasses = tone === 'danger' ? 'bg-red-600' : 'bg-green-600';

  return (
    <button
      {...props}
      aria-checked={checked}
      className={cn('inline-flex items-center gap-2 text-xs font-medium text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2', className)}
      role="switch"
      type={type}
    >
      <span className={cn('relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors', checked ? activeClasses : 'bg-gray-200')}>
        <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
      </span>
      <span>{label}</span>
    </button>
  );
}
