import type { ReactNode } from 'react';

import { Button } from './Button';

type PageHeaderProps = {
  title: string;
  description: string;
  actions?: ReactNode;
  backLabel?: string;
  badges?: ReactNode;
  leading?: ReactNode;
  onBack?: () => void;
};

export function PageHeader({ actions, backLabel = 'Back', badges, description, leading, onBack, title }: PageHeaderProps) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
        {onBack ? <Button icon="back" onClick={onBack}>{backLabel}</Button> : null}
        {leading}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold text-gray-900">{title}</h1>
            {badges}
          </div>
          <p className="mt-0.5 text-sm text-gray-500">{description}</p>
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
