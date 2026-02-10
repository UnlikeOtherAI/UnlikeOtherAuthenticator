import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import type { ClientConfig } from '../../services/config.service.js';
import { getAuthUiTranslations } from '../../services/translation.service.js';
import { AppError } from '../../utils/errors.js';

const ParamsSchema = z.object({
  language: z.string().trim().min(1).max(32),
});

function allowedLanguagesFromConfig(config: ClientConfig): string[] {
  const raw = config.language_config;
  if (typeof raw === 'string') return [raw.trim()].filter(Boolean);
  if (Array.isArray(raw)) return raw.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  return ['en'];
}

export function registerI18nGetRoute(app: FastifyInstance): void {
  // Auth UI i18n: serve a complete translation file for the requested language, generating
  // it via AI and caching permanently when missing.
  app.get(
    '/i18n/:language',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const { language } = ParamsSchema.parse(request.params);
      const config = request.config;
      if (!config) throw new Error('missing request.config');

      const allowed = allowedLanguagesFromConfig(config);
      if (!allowed.includes(language)) {
        throw new AppError('BAD_REQUEST', 400);
      }

      const translations = await getAuthUiTranslations({ language });
      reply.status(200).send(translations);
    },
  );
}

