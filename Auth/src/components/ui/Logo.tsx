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
    const style: React.CSSProperties = {};
    const allowedStyle = theme.logo.style ?? {};

    if (allowedStyle.color) style.color = allowedStyle.color;
    if (allowedStyle.fontSize) style.fontSize = allowedStyle.fontSize;
    if (allowedStyle.fontWeight) style.fontWeight = allowedStyle.fontWeight;
    if (allowedStyle.letterSpacing) style.letterSpacing = allowedStyle.letterSpacing;
    if (theme.logo.fontSize) style.fontSize = theme.logo.fontSize;
    if (theme.logo.color) style.color = theme.logo.color;

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
