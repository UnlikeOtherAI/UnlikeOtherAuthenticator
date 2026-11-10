import React from 'react';

import { useTheme } from '../../hooks/use-theme.js';

export function Button(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'secondary' | 'danger';
  },
): React.JSX.Element {
  const { classNames } = useTheme();
  const { variant = 'primary', className, ...rest } = props;

  const themed =
    variant === 'secondary' ? classNames.buttonSecondary : classNames.buttonPrimary;
  const danger = variant === 'danger' ? ' !border-[var(--uoa-color-danger)] !bg-[var(--uoa-color-danger)] !text-[var(--uoa-color-danger-text)]' : '';
  const merged = className ? `${themed}${danger} ${className}` : `${themed}${danger}`;

  return <button {...rest} className={merged} />;
}

