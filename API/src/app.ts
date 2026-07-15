import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import fastify, { type FastifyInstance } from 'fastify';

import { getEnv, requireEnv } from './config/env.js';
import { connectPrisma, disconnectPrisma } from './db/prisma.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import tenantContextPlugin from './plugins/tenant-context.plugin.js';
import { registerRoutes } from './routes/index.js';
import { sweepExpiredClaims } from './services/integration-claim.service.js';
import { pruneExpiredSecurityData } from './services/retention-pruning.service.js';
import { setAppLogger } from './utils/app-logger.js';

export async function createApp(): Promise<FastifyInstance> {
  const env = getEnv();

  const app = fastify({
    trustProxy: 1,
    // Defence-in-depth caps. The only request body we expect anywhere near this size
    // is the signed config JWT (capped to 64 KiB at the fetch layer). Per-route
    // `bodyLimit` overrides exist where larger bodies are legitimate (e.g. `/email/send`).
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
    keepAliveTimeout: 5_000,
    connectionTimeout: 10_000,
    // Never log bearer tokens or other secrets. Additionally, avoid automatic request
    // logging to prevent sensitive query params (like config_url) from being persisted.
    disableRequestLogging: true,
    logger:
      env.NODE_ENV === 'test'
        ? false
        : {
            level: env.LOG_LEVEL,
            redact: {
              paths: [
                // Common sensitive headers (domain hash + access token).
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-api-key"]',
                'req.headers["x-uoa-access-token"]',
                // Redact common token-like keys if we ever log structured objects containing them.
                'authorization',
                'headers.authorization',
                'headers.cookie',
                'headers["x-api-key"]',
                'headers["x-uoa-access-token"]',
                'token',
                'code',
                'access_token',
                'refresh_token',
                'twofa_token',
                'email_token',
                'signing_token',
                'continuation_token',
                'evidence_signature',
                'evidence_manifest',
                'typedName',
                'signerName',
                'evidenceSignature',
                'evidenceManifest',
                'client_secret',
                'shared_secret',
                'configJwt',
                'config_jwt',
                'sharedSecret',
                'SHARED_SECRET',
                'req.body.password',
                'req.body.passwordHash',
                'req.body.code',
                'req.body.code_verifier',
                'req.body.access_token',
                'req.body.refresh_token',
                'req.body.twofa_token',
                'req.body.email_token',
                'req.body.signing_token',
                'req.body.continuation_token',
                'req.body.typed_name',
                'req.body.signer_name',
                'req.body.evidence_signature',
                'req.body.evidence_manifest',
                'req.body.client_secret',
                'req.body.shared_secret',
                '*.totpSecret',
                '*.recoveryCode',
              ],
              censor: '[REDACTED]',
            },
          },
  });
  setAppLogger(app.log);

  // The integration claim confirm page is a plain HTML form that browsers submit
  // as application/x-www-form-urlencoded. We do not use the body (the token is
  // in the path), so accept the content-type and drop the payload rather than
  // 500-ing with FST_ERR_CTP_INVALID_MEDIA_TYPE.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, _body, done) => {
      done(null, {});
    },
  );

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        connectSrc: ["'self'", 'https:'],
        fontSrc: ["'self'", 'https:', 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'https:', 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: {
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: false,
    },
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  if (env.DATABASE_URL) {
    await connectPrisma();
    app.addHook('onClose', async () => {
      await disconnectPrisma();
    });

    // Brief 22.8/H13: token and login-log retention must be finite. Run a periodic
    // prune so retention doesn't depend on new login events.
    if (env.NODE_ENV !== 'test') {
      const runPrune = async (): Promise<void> => {
        try {
          await pruneExpiredSecurityData();
        } catch (err) {
          app.log.error({ err }, 'failed to prune expired security data');
        }
      };

      const runClaimSweep = async (): Promise<void> => {
        try {
          await sweepExpiredClaims();
        } catch (err) {
          app.log.error({ err }, 'failed to sweep expired integration claim tokens');
        }
      };

      void runPrune();
      void runClaimSweep();

      const intervalMs = 6 * 60 * 60 * 1000;
      const timer = setInterval(() => {
        void runPrune();
        void runClaimSweep();
      }, intervalMs);
      timer.unref();

      app.addHook('onClose', async () => {
        clearInterval(timer);
      });
    }
  } else {
    app.log.warn('DATABASE_URL not set; database is disabled');
  }

  // Signed cookies are used to bind the social-login OAuth `state` to the browser
  // that initiated the flow (login-CSRF protection). The signing key is derived from
  // SHARED_SECRET so the cookie is tamper-evident without introducing a new secret.
  const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
  await app.register(cookie, { secret: SHARED_SECRET });
  await app.register(multipart, {
    limits: {
      fieldNameSize: 100,
      fieldSize: 20 * 1024,
      fields: 8,
      files: 1,
      fileSize: env.SIGNATURE_MAX_PDF_BYTES,
    },
    throwFileSizeLimit: true,
  });

  registerErrorHandler(app);
  await app.register(tenantContextPlugin);
  await registerRoutes(app);

  return app;
}
