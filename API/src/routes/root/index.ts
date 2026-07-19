import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

import {
  accessTokenDocumentation,
  confidentialTokenExchangeDocumentation,
  configJwtDocumentation,
  configValidationEndpointDocumentation,
  configVerificationEndpointDocumentation,
} from './config-docs.js';
import { registerConfigValidateRoute } from './config-validate.js';
import { registerConfigVerifyRoute } from './config-verify.js';
import { registerLlmRoute } from './llm.js';
import { endpoints } from './schema.js';
import { readAdminIndexAssetUrls } from '../../services/admin-ui.service.js';
import { renderRootHoldingPage } from '../../services/root-page.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let version = 'unknown';
try {
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'),
  ) as { version: string };
  version = pkg.version;
} catch {
  // Fallback if package.json is not co-located (e.g. Docker image without it).
}

export function registerRootRoute(app: FastifyInstance): void {
  registerLlmRoute(app);
  registerConfigValidateRoute(app);
  registerConfigVerifyRoute(app);

  app.get('/', async (_request, reply) => {
    const assets = await readAdminIndexAssetUrls();
    reply.header('Cache-Control', 'no-store, no-cache');
    reply.header('Pragma', 'no-cache');
    reply.type('text/html; charset=utf-8').send(renderRootHoldingPage(assets));
  });

  app.get('/api', async () => {
    return {
      name: 'UnlikeOtherAuthenticator',
      description:
        'Centralized OAuth and authentication service used by multiple products, including one-time first-hop assertions and audience-bound chained confidential exchange.',
      version,
      repository: 'https://github.com/UnlikeOtherAI/UnlikeOtherAuthenticator',
      home: '/',
      docs: '/llm',
      api: '/api',
      config_jwt: configJwtDocumentation,
      access_token: accessTokenDocumentation,
      confidential_token_exchange: confidentialTokenExchangeDocumentation,
      config_validation: configValidationEndpointDocumentation,
      config_verification: configVerificationEndpointDocumentation,
      endpoints,
    };
  });
}
