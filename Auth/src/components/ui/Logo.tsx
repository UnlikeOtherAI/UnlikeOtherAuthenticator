import React from 'react';

import { useTheme } from '../../hooks/use-theme.js';

export function Logo(): React.JSX.Element | null {
  const { theme } = useTheme();

  if (theme.logo.url) {
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

  if (theme.logo.text) {
    const style: React.CSSProperties = {
      ...theme.logo.style,
      ...(theme.logo.fontSize ? { fontSize: theme.logo.fontSize } : {}),
      ...(theme.logo.color ? { color: theme.logo.color } : {}),
    };

    return (
      <span
        className="font-semibold leading-tight"
        style={style}
        role="img"
        aria-label={theme.logo.alt}
      >
        {theme.logo.text}
      </span>
    );
  }

  return null;
}
