import { AppError } from '../utils/errors.js';

export function resolveStripeCatalogDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;
  if (!url) {
    throw new AppError('INTERNAL', 503, 'STRIPE_CATALOG_DATABASE_URL_REQUIRED');
  }
  return url;
}
