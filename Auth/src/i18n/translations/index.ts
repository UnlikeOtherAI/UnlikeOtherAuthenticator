import { en } from './en.js';
import { es } from './es.js';

export const translationsByLanguage = {
  en,
  es,
} as const;

export type SupportedLanguage = keyof typeof translationsByLanguage;

