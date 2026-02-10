import React from 'react';

import { useTranslation } from '../../i18n/use-translation.js';

function labelForLanguage(code: string): string {
  const v = code.trim().toLowerCase();
  if (v === 'en') return 'English';
  if (v === 'es') return 'Espanol';
  return code.trim() ? code.trim().toUpperCase() : 'LANG';
}

function selectClasses(): string {
  return [
    'rounded-[var(--uoa-radius-input)] border border-[var(--uoa-color-border)]',
    'bg-[var(--uoa-color-surface)] px-3 py-2 text-sm text-[var(--uoa-color-text)]',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--uoa-color-primary)]',
    'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--uoa-color-bg)]',
  ].join(' ');
}

export function LanguageSelector(): React.JSX.Element | null {
  const { language, languages, setLanguage } = useTranslation();

  // Brief: single language (no selector). Dropdown only shown when multiple languages provided.
  if (languages.length <= 1) return null;

  return (
    <div className="mb-4 flex justify-end">
      <select
        className={selectClasses()}
        aria-label="Language"
        data-testid="language-selector"
        value={language}
        onChange={(e) => setLanguage(e.currentTarget.value)}
      >
        {languages.map((code) => (
          <option key={code} value={code}>
            {labelForLanguage(code)}
          </option>
        ))}
      </select>
    </div>
  );
}

