export type Density = 'compact' | 'comfortable' | 'spacious';

export type ButtonStyle = 'solid' | 'outline' | 'ghost';
export type CardStyle = 'plain' | 'bordered' | 'shadow';

export type FontFamily = 'sans' | 'serif' | 'mono';
export type BaseTextSize = 'sm' | 'md' | 'lg';

export type ThemeVars = Record<string, string>;

export type Theme = {
  vars: ThemeVars;
  density: Density;
  typography: {
    fontFamily: FontFamily;
    baseTextSize: BaseTextSize;
  };
  button: {
    style: ButtonStyle;
  };
  card: {
    style: CardStyle;
  };
  logo: {
    url: string;
    alt: string;
  };
};

export type ThemeClassNames = {
  appShell: string;
  pageContainer: string;
  card: string;
  logoWrap: string;
  title: string;
  buttonPrimary: string;
  buttonSecondary: string;
};

