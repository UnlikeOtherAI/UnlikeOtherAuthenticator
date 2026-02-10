import React from 'react';

import { TwoFactorVerify } from '../components/twofactor/TwoFactorVerify.js';
import { useTheme } from '../hooks/use-theme.js';

export function TwoFactorVerifyPage(): React.JSX.Element {
  const { classNames } = useTheme();

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>Verify two-factor code</h1>
      <TwoFactorVerify />
    </div>
  );
}

