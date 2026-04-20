import helmet from '@fastify/helmet';
import fastify, { type FastifyInstance } from 'fastify';

import { getEnv } from './config/env.js';
import { connectPrisma, disconnectPrisma } from './db/prisma.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerRoutes } from './routes/index.js';
import { pruneLoginLogs } from './services/login-log.service.js';

export async function createApp(): Promise<FastifyInstance> {
  const env = getEnv();

  const app = fastify({
    trustProxy: true,
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
                'req.headers["x-uoa-access-token"]',
                // Redact common token-like keys if we ever log structured objects containing them.
                'authorization',
                'headers.authorization',
                'headers.cookie',
                'headers["x-uoa-access-token"]',
                'token',
                'access_token',
                'refresh_token',
                'configJwt',
                'config_jwt',
                'sharedSecret',
                'SHARED_SECRET',
              ],
              censor: '[REDACTED]',
            },
          },
  });

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
      preload: true,
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

    // Brief 22.8: login log retention must be finite. Run a periodic prune so retention
    // doesn't depend on new login events.
    if (env.NODE_ENV !== 'test') {
      const runPrune = async (): Promise<void> => {
        try {
          await pruneLoginLogs();
        } catch (err) {
          app.log.error({ err }, 'failed to prune login logs');
        }
      };

      void runPrune();

      const intervalMs = 6 * 60 * 60 * 1000;
      const timer = setInterval(() => {
        void runPrune();
      }, intervalMs);
      timer.unref();

      app.addHook('onClose', async () => {
        clearInterval(timer);
      });
    }
  } else {
    app.log.warn('DATABASE_URL not set; database is disabled');
  }

  registerErrorHandler(app);
  await registerRoutes(app);

  return app;
}
