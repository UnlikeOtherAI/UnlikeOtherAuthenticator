import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { getAppStartup } from '../../services/app-startup.service.js';

const PlatformSchema = z.enum(['ios', 'android', 'web', 'macos', 'windows', 'other']);

const QuerySchema = z
  .object({
    config_url: z.string().trim().min(1),
    appIdentifier: z.string().trim().toLowerCase().min(1),
    platform: PlatformSchema,
    versionName: z.string().trim().min(1).optional(),
    versionCode: z.string().trim().min(1).optional(),
    buildNumber: z.string().trim().min(1).optional(),
    userId: z.string().trim().min(1).optional(),
    teamId: z.string().trim().min(1).optional(),
  })
  .strict();

export function registerAppStartupRoute(app: FastifyInstance): void {
  app.get(
    '/apps/startup',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const query = QuerySchema.parse(request.query);
      const config = request.config;
      if (!config) throw new Error('missing request.config');

      const response = await getAppStartup(
        {
          domain: config.domain,
          appIdentifier: query.appIdentifier,
          platform: query.platform,
          versionName: query.versionName,
          versionCode: query.versionCode,
          buildNumber: query.buildNumber,
          userId: query.userId,
        },
        {
          env: getEnv(),
          prisma: request.adminDb,
        },
      );

      reply.status(200).send(response);
    },
  );
}
