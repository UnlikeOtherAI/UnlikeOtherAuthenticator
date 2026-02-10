import type { FastifyInstance } from 'fastify';

import { configVerifier } from '../../middleware/config-verifier.js';
import {
  readAuthUiAsset,
  renderAuthEntrypointHtml,
} from '../../services/auth-ui.service.js';

export function registerAuthEntrypointRoute(app: FastifyInstance): void {
  // OAuth popup entrypoint. This must start by fetching the config JWT from a URL supplied by the client.
  app.get(
    '/auth',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      if (!request.config || !request.configUrl) {
        // configVerifier should always attach these; fail closed.
        reply.status(400).send({ error: 'Request failed' });
        return;
      }

      const requestUrl = request.raw.url ?? '';
      const html = await renderAuthEntrypointHtml({
        config: request.config,
        configUrl: request.configUrl,
        requestUrl,
      });
      reply.type('text/html; charset=utf-8').status(200).send(html);
    },
  );

  // Serve the built Auth app assets needed by `Auth/dist/index.html`.
  //
  // Note: we intentionally avoid adding extra Fastify plugins for this simple static
  // use-case; later tasks can replace this with a more complete static/SSR solution.
  app.get('/assets/*', async (request, reply) => {
    const params = request.params as { '*': string };
    const rel = params['*'] ?? '';
    const { body, contentType } = await readAuthUiAsset({
      relativePath: pathJoin('assets', rel),
    });
    reply.type(contentType).status(200).send(body);
  });
}

function pathJoin(prefix: string, rest: string): string {
  const normalizedRest = rest.replace(/^\/+/, '');
  return `${prefix}/${normalizedRest}`;
}
