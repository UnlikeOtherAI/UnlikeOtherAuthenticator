import React, { createContext, useMemo } from 'react';

import { buildThemeClassNames, buildThemeFromConfig, themeVarsToCss } from './theme-utils.js';
import type { Theme, ThemeClassNames } from './theme-types.js';

export type ThemeContextValue = {
  theme: Theme;
  classNames: ThemeClassNames;
  configUrl: string;
};

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider(props: {
  config: unknown;
  configUrl: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = useMemo<ThemeContextValue>(() => {
    const theme = buildThemeFromConfig(props.config);
    return {
      theme,
      classNames: buildThemeClassNames(theme),
      configUrl: props.configUrl,
    };
  }, [props.config, props.configUrl]);

  const cssText = useMemo(() => {
    // Scope theme vars to this subtree to avoid accidental leakage if the app is embedded.
    return `.uoa-theme{${themeVarsToCss(value.theme.vars)}}`;
  }, [value.theme.vars]);

  return (
    <ThemeContext.Provider value={value}>
      <div className="uoa-theme">
        <style>{cssText}</style>
        {props.children}
      </div>
    </ThemeContext.Provider>
  );
}

