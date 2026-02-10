import React from 'react';

import { TwoFactorSetup } from '../components/twofactor/TwoFactorSetup.js';
import { useTheme } from '../hooks/use-theme.js';

export function TwoFactorSetupPage(): React.JSX.Element {
  const { classNames } = useTheme();

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>Set up two-factor authentication</h1>
      <TwoFactorSetup />
    </div>
  );
}

