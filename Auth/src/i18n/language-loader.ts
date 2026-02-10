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
      const url = new URL(`/i18n/${encodeURIComponent(language)}`, window.location.origin);
      url.searchParams.set('config_url', configUrl);

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const json: unknown = await res.json().catch(() => null);
      return normalizeTranslationFile(json);
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}

