import { getJson } from '../utils/api.js';

type TranslationFile = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTranslationFile(value: unknown): TranslationFile | null {
  if (!isRecord(value)) return null;
  const out: TranslationFile = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

const inFlight = new Map<string, Promise<TranslationFile | null>>();

export function loadTranslations(params: {
  language: string;
  configUrl: string;
}): Promise<TranslationFile | null> {
  const language = params.language.trim();
  const configUrl = params.configUrl.trim();
  if (!language || !configUrl) return Promise.resolve(null);

  const key = `${language}|${configUrl}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      const result = await getJson<unknown>(
        `/i18n/${encodeURIComponent(language)}`,
        { config_url: configUrl },
      );
      if (!result.ok) return null;
      return normalizeTranslationFile(result.data);
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}
