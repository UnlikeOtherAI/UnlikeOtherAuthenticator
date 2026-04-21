import type { ButtonHTMLAttributes } from 'react';

import type { IconName } from '../icons/Icon';
import { Icon } from '../icons/Icon';
import { cn } from '../../utils/cn';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
};

const variants: Record<ButtonVariant, string> = {
  primary: 'border-indigo-600 bg-indigo-600 text-white hover:border-indigo-500 hover:bg-indigo-500 focus:ring-indigo-500',
  secondary: 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 focus:ring-indigo-500',
  danger: 'border-red-600 bg-red-600 text-white hover:border-red-700 hover:bg-red-700 focus:ring-red-500',
  ghost: 'border-transparent bg-transparent text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:ring-indigo-500',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-3.5 text-sm',
};

export function Button({ children, className, disabled, icon, size = 'md', type = 'button', variant = 'secondary', ...props }: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-60',
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {icon ? <Icon name={icon} className="h-3.5 w-3.5" /> : null}
      {children}
    </button>
  );
}
