import React from 'react';

import { useTheme } from '../../hooks/use-theme.js';

export function Logo(): React.JSX.Element | null {
  const { theme } = useTheme();
  if (!theme.logo.url) return null;

  return (
    <img
      src={theme.logo.url}
      alt={theme.logo.alt}
      className="h-10 w-auto"
      loading="eager"
      decoding="async"
    />
  );
}

