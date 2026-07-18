import type { FastifyInstance } from 'fastify';

import { llmIntegrationMarkdown } from './llm-integration.js';
import { llmIntegrationMarkdown2 } from './llm-integration-2.js';
import { llmIntroMarkdown } from './llm-intro.js';
import { llmSignaturesMarkdown } from './llm-signatures.js';

function renderLlmMarkdown(): string {
  // llmIntegrationMarkdown owns the confidential assertion contract, including
  // the mandatory fresh-jti and one-time replay-protection requirements.
  return `${llmIntroMarkdown}\n${llmIntegrationMarkdown}\n${llmIntegrationMarkdown2}\n${llmSignaturesMarkdown}`;
}

export function registerLlmRoute(app: FastifyInstance): void {
  app.get('/llm', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/markdown; charset=utf-8').send(renderLlmMarkdown());
  });
}
