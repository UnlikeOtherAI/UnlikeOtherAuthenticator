import type { FastifyInstance } from 'fastify';

import { llmBillingMarkdown } from './llm-billing.js';
import { llmIntegrationMarkdown } from './llm-integration.js';
import { llmIntegrationMarkdown2 } from './llm-integration-2.js';
import { llmIntroMarkdown } from './llm-intro.js';
import { llmSignaturesMarkdown } from './llm-signatures.js';

function renderLlmMarkdown(): string {
  // llmIntegrationMarkdown owns both confidential subject profiles: one-time
  // source assertions and reusable, audience-bound chained access tokens.
  return `${llmIntroMarkdown}\n${llmIntegrationMarkdown}\n${llmIntegrationMarkdown2}\n${llmBillingMarkdown}\n${llmSignaturesMarkdown}`;
}

export function registerLlmRoute(app: FastifyInstance): void {
  app.get('/llm', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/markdown; charset=utf-8').send(renderLlmMarkdown());
  });
}
