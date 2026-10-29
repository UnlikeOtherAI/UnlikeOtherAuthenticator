import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getEnv } from '../../config/env.js';
import {
  facebookProofCode,
  readFacebookProofCookie,
  verifyFacebookEmailProof,
} from '../../services/social/facebook-email-proof.service.js';
import { setSocialInviteCookie, setSocialStateCookie } from '../../services/social/social-state-cookie.js';
import { verifyCodeRateLimiter } from './rate-limit-keys.js';

const BodySchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

export function registerFacebookEmailProofRoute(app: FastifyInstance): void {
  app.post('/auth/facebook-proof/verify', {
    preHandler: [verifyCodeRateLimiter],
  }, async (request, reply) => {
    const { code } = BodySchema.parse(request.body);
    const proof = await verifyFacebookEmailProof({
      cookie: readFacebookProofCookie(request),
      code,
      prisma: request.adminDb,
    });
    setSocialStateCookie(reply, proof.nonce, 'facebook');
    if (proof.inviteToken) setSocialInviteCookie(reply, proof.inviteToken, 'facebook');
    const env = getEnv();
    const baseUrl = (env.PUBLIC_BASE_URL ?? `http://${env.HOST}:${env.PORT}`).replace(/\/+$/, '');
    const redirect = new URL(`${baseUrl}/auth/callback/facebook`);
    redirect.searchParams.set('code', facebookProofCode(proof.id));
    redirect.searchParams.set('state', proof.stateJwt);
    reply.header('Cache-Control', 'no-store').send({ redirect_url: redirect.toString() });
  });
}
