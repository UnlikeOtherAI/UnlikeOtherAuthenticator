import type { FastifyInstance } from 'fastify';

import { llmIntegrationMarkdown } from './llm-integration.js';
import { llmIntroMarkdown } from './llm-intro.js';

function renderLlmMarkdown(): string {
  return `${llmIntroMarkdown}\n${llmIntegrationMarkdown}`;
}

export function registerLlmRoute(app: FastifyInstance): void {
  app.get('/llm', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/markdown; charset=utf-8').send(renderLlmMarkdown());
  });
}
