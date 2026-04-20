import type { FastifyBaseLogger } from 'fastify';

let appLogger: FastifyBaseLogger | undefined;

export function setAppLogger(logger: FastifyBaseLogger): void {
  appLogger = logger;
}

export function getAppLogger(): FastifyBaseLogger {
  if (!appLogger) {
    throw new Error('App logger not initialized');
  }

  return appLogger;
}
