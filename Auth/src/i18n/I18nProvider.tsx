import React, { createContext, useContext, useMemo, useState } from 'react';

import { translationsByLanguage } from './translations/index.js';
import type { TranslationKey } from './translations/en.js';

type I18nContextValue = {
  language: string;
  languages: string[];
  setLanguage: (language: string) => void;
  t: (key: TranslationKey) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readLanguageConfig(config: unknown): { language: string; languages: string[] } {
  if (!isRecord(config)) return { language: 'en', languages: ['en'] };

  const raw = config.language_config;
  if (typeof raw === 'string') {
    const v = raw.trim();
    return v ? { language: v, languages: [v] } : { language: 'en', languages: ['en'] };
  }

  if (Array.isArray(raw)) {
    const langs = raw
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean);
    if (langs.length === 0) return { language: 'en', languages: ['en'] };
    return { language: langs[0] ?? 'en', languages: langs };
  }

  return { language: 'en', languages: ['en'] };
}

export function I18nProvider(props: {
  config: unknown;
  children: React.ReactNode;
}): React.JSX.Element {
  const initial = useMemo(() => readLanguageConfig(props.config), [props.config]);
  const [language, setLanguageState] = useState<string>(initial.language);

  const value = useMemo<I18nContextValue>(() => {
    const languages = initial.languages;
    const safeLanguage = languages.includes(language) ? language : (languages[0] ?? 'en');

    return {
      language: safeLanguage,
      languages,
      setLanguage: (next) => {
        const trimmed = next.trim();
        if (!trimmed) return;
        if (!languages.includes(trimmed)) return;
        setLanguageState(trimmed);
      },
      t: (key) => {
        const langKey =
          safeLanguage in translationsByLanguage
            ? (safeLanguage as keyof typeof translationsByLanguage)
            : 'en';

        const active = translationsByLanguage[langKey] ?? translationsByLanguage.en;
        const fallback = translationsByLanguage.en;
        return active[key] ?? fallback[key] ?? key;
      },
    };
  }, [initial.languages, language]);

  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within <I18nProvider />');
  return ctx;
}

