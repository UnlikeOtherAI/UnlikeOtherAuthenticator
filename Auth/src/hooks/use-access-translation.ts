import { useI18n } from '../i18n/I18nProvider.js';
import { accessCs, accessEn, accessEs, type AccessKey } from '../i18n/organisation-access.js';

export function useAccessTranslation() {
  const { language } = useI18n();
  const dictionary = language === 'cs' ? accessCs : language === 'es' ? accessEs : accessEn;
  return (key: AccessKey, values?: Record<string, string>) => {
    let text: string = dictionary[key];
    for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, value);
    return text;
  };
}
