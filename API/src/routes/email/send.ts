import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configJwtHeaderVerifier } from '../../middleware/config-jwt-header-verifier.js';
import { requireSendableDomainEmailConfig } from '../../services/domain-email-config.service.js';
import { sendRawEmail } from '../../services/email.service.js';
import { AppError } from '../../utils/errors.js';

const SendEmailBodySchema = z
  .object({
    to: z.string().email(),
    subject: z.string().trim().min(1).max(998),
    text: z.string().min(1),
    html: z.string().min(1).optional(),
    reply_to: z.string().email().optional(),
  })
  .strict();

export function registerEmailSendRoute(app: FastifyInstance): void {
  app.post(
    '/email/send',
    {
      preHandler: [configJwtHeaderVerifier],
      schema: {
        response: {
          202: {
            type: 'object',
            required: ['ok'],
            properties: { ok: { type: 'boolean' } },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.config) throw new AppError('UNAUTHORIZED', 401);
      const body = SendEmailBodySchema.parse(request.body);
      const config = await requireSendableDomainEmailConfig(request.config.domain);

      await sendRawEmail({
        to: body.to,
        subject: body.subject,
        text: body.text,
        html: body.html,
        from: config.fromAddress ?? '',
        fromName: config.fromName,
        replyTo: body.reply_to ?? config.replyToDefault,
      });

      return reply.status(202).send({ ok: true });
    },
  );
}
