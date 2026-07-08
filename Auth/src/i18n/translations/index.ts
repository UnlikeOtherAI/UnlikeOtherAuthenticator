import { en } from './en.js';
import { cs } from './cs.js';
import { es } from './es.js';

export const translationsByLanguage = {
  en,
  cs,
  es,
} as const;

export type SupportedLanguage = keyof typeof translationsByLanguage;
