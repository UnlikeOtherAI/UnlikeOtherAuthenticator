import React from 'react';

import { useTheme } from '../../hooks/use-theme.js';
import { Card } from '../ui/Card.js';
import { Logo } from '../ui/Logo.js';
import { LanguageSelector } from './LanguageSelector.js';

export function AuthLayout(props: { children: React.ReactNode }): React.JSX.Element {
  const { classNames } = useTheme();

  return (
    <div className={classNames.appShell}>
      <main className={classNames.pageContainer}>
        <div className={classNames.logoWrap}>
          <Logo />
        </div>
        <LanguageSelector />
        <Card>{props.children}</Card>
      </main>
    </div>
  );
}
