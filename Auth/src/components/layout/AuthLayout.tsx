import React from 'react';

import { useTheme } from '../../hooks/use-theme.js';
import { usePopup } from '../../hooks/use-popup.js';
import { Card } from '../ui/Card.js';
import { Logo } from '../ui/Logo.js';
import { LanguageSelector } from './LanguageSelector.js';

export function AuthLayout(props: { children: React.ReactNode }): React.JSX.Element {
  const { classNames } = useTheme();
  const { view } = usePopup();
  const pageContainer =
    view === 'signatures'
      ? classNames.pageContainer.replace('max-w-lg', 'max-w-5xl')
      : classNames.pageContainer;

  return (
    <div className={classNames.appShell}>
      <main className={pageContainer}>
        <div className={classNames.logoWrap}>
          <Logo />
        </div>
        <LanguageSelector />
        <Card>{props.children}</Card>
      </main>
    </div>
  );
}
